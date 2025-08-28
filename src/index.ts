import express, { Request, Response } from "express";
import bodyParser from "body-parser";
import WebSocket from "ws";
import OpenAI from "openai";
import twilio from "twilio";
import "dotenv/config";

const DOMAIN = process.env.DOMAIN;
const PORT = Number(process.env.PORT ?? 8000);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_PROJECT_ID = process.env.OPENAI_PROJECT_ID;
const WEBHOOK_SECRET = process.env.OPENAI_WEBHOOK_SECRET;
const openAiClient = new OpenAI({ apiKey: OPENAI_API_KEY });

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(accountSid, authToken);

const HUMAN_AGENT_NUMBER = process.env.HUMAN_AGENT_NUMBER;

if (!DOMAIN || !OPENAI_API_KEY || !OPENAI_PROJECT_ID || !WEBHOOK_SECRET || !accountSid || !authToken || !HUMAN_AGENT_NUMBER) {
  console.error("Missing some variables in your .env");
  process.exit(1);
}

const app = express();
app.use(bodyParser.raw({ type: "*/*" }));
const RealtimeIncomingCall = "realtime.call.incoming" as const;

var callIDtoConferenceNameMapping: Record<string, string | undefined> = {};
var ConferenceNametoCallerIDMapping: Record<string, string | undefined> = {};
var ConferenceNametoCallTokenMapping: Record<string, string | undefined> = {};

const WELCOME_GREETING = "Hello, I'm an AI agent. How can I help you?";
const SYSTEM_PROMPT = "You are a support agent. Speak in English unless the user requests a different language. If the caller asks to speak to a real person, use the addHumanAgent function.";
const MODEL = "gpt-realtime-2025-08-28";
const VOICE = "alloy";

const responseCreate = {
  type: "response.create",
  response: {
    instructions: `Say to the user: ${WELCOME_GREETING}`,
  },
} as const;

const callAccept = {
    instructions: SYSTEM_PROMPT,
    model: MODEL,
    voice: VOICE,
    //type: "realtime",
    tools: [
      {
          type: 'function',
          name: 'addHumanAgent',
          description: 'Adds a human agent to the call with the user.',
          parameters: {"type": "object", "properties": {}, "required": []},
      }
  ]
} as const;

app.post("/incoming-call", (req: Request, res: Response) => {

  const rawBody = req.body.toString("utf8");
  const parsedBody = Object.fromEntries(new URLSearchParams(rawBody));

  const conferenceName = `${parsedBody.CallSid}`;

  ConferenceNametoCallerIDMapping[conferenceName] = parsedBody.From;
  ConferenceNametoCallTokenMapping[conferenceName] = parsedBody.CallToken;

  async function createParticipant() {
    
      await client
          .conferences(conferenceName)
          .participants.create({
              from: parsedBody.From, // Use the from number from the call
              label: "virtual agent",
              to: `sip:${OPENAI_PROJECT_ID}@sip.api.openai.com;transport=tls?X-conferenceName=${conferenceName}`,
              earlyMedia: false,
              callToken: parsedBody.CallToken,
              conferenceStatusCallback: `https://${DOMAIN}/conference-events`,
              conferenceStatusCallbackEvent: ['join']
          });      
  }
  createParticipant();

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                        <Response>
                            <Dial>
                                <Conference 
                                    startConferenceOnEnter="true"
                                    participantLabel="customer"
                                    endConferenceOnExit="true"
                                    statusCallback="https://${DOMAIN}/conference-events"
                                    statusCallbackEvent="join"
                                >
                                    ${conferenceName}
                                </Conference>
                            </Dial>
                        </Response>`;
  res.type('text/xml').send(twimlResponse);
});


app.post("/conference-events", (req: Request, res: Response) => {

  const rawBody = req.body.toString("utf8");
  const parsedBody = Object.fromEntries(new URLSearchParams(rawBody));

  if (parsedBody.ParticipantLabel === 'human agent' && parsedBody.StatusCallbackEvent === 'participant-join') {
      
      async function findVirtualAgentandDisconnect() {
          const participants = await client
            .conferences(parsedBody.ConferenceSid)
            .participants.list({
              limit: 20,
            });
        
          for (const participant of participants) {
              if (participant.label === 'virtual agent') {

                  // End the virtual agent call
                  await client.calls(participant.callSid).update({ status: 'completed' });
                  console.log('Virtual agent call ended.');
              }
          }
        }

      findVirtualAgentandDisconnect();
      
  }
});

app.get("/health", async (req: Request, res: Response ) => {
  return res.status(200).send(`Health ok`);
});

app.post("/", async (req: Request, res: Response) => {

  try {
    const event = await openAiClient.webhooks.unwrap(
      req.body.toString("utf8"),
      req.headers as Record<string, string>,
      WEBHOOK_SECRET
    );

    const type = (event as any)?.type;

    if (type === RealtimeIncomingCall) {
      const callId: string = (event as any)?.data?.call_id;
      const sipHeaders = (event as any)?.data?.sip_headers;

      let foundConferenceName: string | undefined;

      if (Array.isArray(sipHeaders)) {
        const conferenceHeader = sipHeaders.find(
          (header: any) => header.name === "X-conferenceName"
        );
        foundConferenceName = conferenceHeader?.value;
      }
  
      callIDtoConferenceNameMapping[callId] = foundConferenceName;


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

const connectWithDelay = async (sipWssUrl: string, delay: number = 1000): Promise<void> => {
  try{
    setTimeout(async () => await websocketTask(sipWssUrl), delay );
  }catch(e){
    console.error(`Error connecting web socket ${e}`);
  }
  
}

const websocketTask = async (uri: string): Promise<void> => {

  const ws = new WebSocket(uri, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
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

    try {
      const response = JSON.parse(text);
      
      if (response.type === 'response.done') {
          const output = response.response?.output?.[0];
          if (output) {
              handleFunctionCall(output, uri);
          };
          }
      
  } catch (error) {
      console.error('Error processing OpenAI message:', error, 'Raw message:', data);
  }
  });

  function handleFunctionCall(output: { type: string; name: string; call_id: any; }, uri: string | URL) {

    if (output?.type === "function_call" &&
        output?.name === "addHumanAgent" &&
        output?.call_id
      ) {
        const url = new URL(uri);
        const extractedCallId = url.searchParams.get("call_id");
  
        if (extractedCallId) {
          addHuman(extractedCallId);
        } else {
          console.error("Call ID is null, cannot add human agent.");
        }
  
        const keepChatting = {
            type: 'conversation.item.create',
            item: {
                type: 'message',
                role: 'user',
                content: [
                    {
                        type: 'input_text',
                        text: 'While we wait for the human agent, keep chatting with the user or ask if theres anything you can help with while they wait.',
                    }
                ]
            }
        };
  
        ws.send(JSON.stringify(keepChatting));
        ws.send(JSON.stringify({ type: 'response.create' }));
    }
  }

  async function addHuman(openAiCallId : string) {

    const conferenceName = callIDtoConferenceNameMapping[openAiCallId];
    if (!conferenceName) {
      console.error('Conference name is undefined for call ID:', openAiCallId);
      return;
    }
    console.log('Adding human to conference:', conferenceName);
    const callToken = ConferenceNametoCallTokenMapping[conferenceName];
    const callerID = ConferenceNametoCallerIDMapping[conferenceName];

    const participant = await client
        .conferences(conferenceName)
        .participants.create({
            from: callerID ?? (() => { throw new Error("CallerID is not defined"); })(),
            label: "human agent",
            to: HUMAN_AGENT_NUMBER ?? (() => { throw new Error("HUMAN_AGENT_NUMBER is not defined"); })(),
            earlyMedia: false,
            callToken: callToken ?? (() => { throw new Error("CallToken is not defined"); })(),
        });
  }
  

  ws.on("error", (e) => {
    console.error("WebSocket error:", JSON.stringify(e));
  });

  ws.on("close", (code, reason) => {
    console.log("WebSocket closed:", code, reason?.toString?.());
  });
}