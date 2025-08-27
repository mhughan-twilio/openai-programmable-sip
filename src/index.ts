import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import WebSocket from "ws";
import OpenAI from "openai";
import "dotenv/config";

const PORT = Number(process.env.PORT ?? 8000);
const WEBHOOK_SECRET = process.env.OPENAI_WEBHOOK_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!WEBHOOK_SECRET || !OPENAI_API_KEY) {
  console.error("Missing OPENAI_WEBHOOK_SECRET or OPENAI_API_KEY in .env");
  process.exit(1);
}

const app = express();
app.use(bodyParser.raw({ type: "*/*" }));

const client = new OpenAI({ apiKey: OPENAI_API_KEY });

const callAccept = {
    instructions: "You are a support agent. Speak in English unless the user requests a different language.",
    model: "gpt-4o-realtime-preview-2025-06-03",
    voice: "alloy",
    type: "realtime",
} as const;

const WELCOME_GREETING = "Thank you for calling, how can I help you?";

const responseCreate = {
  type: "response.create",
  response: {
    instructions: `Say to the user: ${WELCOME_GREETING}`,
  },
} as const;

const RealtimeIncomingCall = "realtime.call.incoming" as const;

const websocketTask = async (uri: string): Promise<void> => {

  const ws = new WebSocket(uri, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
      origin: "https://api.openai.com",
    },
  });

  ws.on("open", () => {
    console.log(`WS OPEN ${uri}`);
    ws.send(JSON.stringify(responseCreate));
  });

  ws.on("message", (data) => {
    const text = typeof data === "string" ? data : data.toString("utf8");
  });

  ws.on("error", (e) => {
    console.error("WebSocket error:", JSON.stringify(e));
  });

  ws.on("close", (code, reason) => {
    console.log("WebSocket closed:", code, reason?.toString?.());
  });
}

const connectWithDelay = async (sipWssUrl: string, delay: number = 1000): Promise<void> => {

  try{
    setTimeout(async () => await websocketTask(sipWssUrl), delay );
  }catch(e){
    console.error(`Error connecting web socket ${e}`);
  }
  
}

app.get("/health", async (req: Request, res: Response ) => {
  return res.status(200).send(`Health ok`);
});

app.post("/", async (req: Request, res: Response) => {

  try {
    const event = await client.webhooks.unwrap(
      req.body.toString("utf8"),
      req.headers as Record<string, string>,
      WEBHOOK_SECRET
    );

    const type = (event as any)?.type;

    if (type === RealtimeIncomingCall) {
      const callId: string = (event as any)?.data?.call_id;


      // Accept the Call 
      const resp = await fetch(
        `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/accept`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json",
            "OpenAI-Beta": "realtime=v1", 
          },
          body: JSON.stringify(callAccept),
        }
      );

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        console.error("ACCEPT failed:", resp.status, resp.statusText, text);
        return res.status(500).send("Accept failed");
      }


      // Connect the web socket after a short delay
      const wssUrl = `wss://api.openai.com/v1/realtime?call_id=${callId}`
      await connectWithDelay(wssUrl, 0); // lengthen delay if needed

      // Acknowledge the webhook
      res.set("Authorization", `Bearer ${OPENAI_API_KEY}`);
      return res.sendStatus(200);
    }

    return res.sendStatus(200);

  } catch (e: any) {
    const msg = String(e?.message ?? "");
    if (e?.name === "InvalidWebhookSignatureError" || msg.toLowerCase().includes("invalid signature")) {
      return res.status(400).send("Invalid signature");
    }
    return res.status(500).send("Server error");
  }
});

app.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
});
