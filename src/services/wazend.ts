import dotenv from 'dotenv';

dotenv.config();

const WAZEND_API_BASE = process.env.WAZEND_API_BASE || "https://api1.wazend.net";
const WAZEND_SESSION = process.env.WAZEND_SESSION || "P2863";
const WAZEND_API_TOKEN = process.env.WAZEND_API_TOKEN || "362F28B3-D3D7-4D72-BAA0-1FAD3364E83C";
const MOCK_WAZEND = process.env.MOCK_WAZEND === "true";

/**
 * Checks the connection state of the WAZEND instance.
 * Returns true if connected (open), false otherwise.
 */
export async function checkWazendConnection(): Promise<boolean> {
  if (MOCK_WAZEND) return true;
  const url = `${WAZEND_API_BASE}/instance/connectionState/${WAZEND_SESSION}`;
  console.log(`[WAZEND] Checking connection for instance ${WAZEND_SESSION}...`);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'apikey': WAZEND_API_TOKEN
      }
    });

    if (!response.ok) {
      console.error(`[WAZEND] Connection check failed: ${response.status} ${response.statusText}`);
      return false;
    }

    const data = await response.json();
    // Expected response: { instance: { state: "open" } }
    // or similar depending on version. 
    // Based on user testing, it returns valid data.
    
    // Check for "open" state (Evolution API standard)
    const state = (data as any)?.instance?.state;
    if (state === 'open') {
      console.log(`[WAZEND] Connection is HEALTHY (State: ${state}).`);
      return true;
    } else {
      console.warn(`[WAZEND] Connection state is NOT open: ${state}`);
      return false;
    }

  } catch (error) {
    console.error(`[WAZEND] Network error checking connection:`, error);
    return false;
  }
}

/**
 * Sends a text message via WAZEND.
 */
export async function sendWazendMessage(phoneNumber: string, text: string) {
  if (MOCK_WAZEND) return;
  // Correct Endpoint for Evolution/Baileys API: /message/sendText/{instance}
  const url = `${WAZEND_API_BASE}/message/sendText/${WAZEND_SESSION}`;

  try {
    const body = {
      number: phoneNumber, // Format: 51999999999
      text: text,
      options: {
        delay: 1200,
        presence: "composing"
      }
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': WAZEND_API_TOKEN
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("WAZEND Error:", response.status, err);
    } else {
      console.log("WAZEND Message Sent:", phoneNumber);
    }
  } catch (e) {
    console.error("WAZEND Network Error:", e);
  }
}

export async function sendWazendReaction(remoteJid: string, messageId: string, emoji: string) {
  if (MOCK_WAZEND) return;
  const url = `${WAZEND_API_BASE}/message/sendReaction/${WAZEND_SESSION}`;

  try {
    const body = {
      key: {
        remoteJid,
        fromMe: false,
        id: messageId
      },
      reaction: emoji
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': WAZEND_API_TOKEN
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("WAZEND Error:", response.status, err);
    } else {
      console.log("WAZEND Reaction Sent:", remoteJid, emoji);
    }
  } catch (e) {
    console.error("WAZEND Network Error:", e);
  }
}
