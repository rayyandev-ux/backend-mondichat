import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { processUserQuery, transcribeAudio } from '../services/aiAgent.js';
import { sendWazendMessage } from '../services/wazend.js';

const prisma = new PrismaClient();

// Wazend Webhook Payload Type Definition (Simplified)
interface WazendMessage {
  id?: string;
  pushName?: string;
  isGroup?: boolean;
  key: {
    remoteJid: string;
    remoteJidAlt?: string; // Added field for alternative JID
    fromMe: boolean;
    id: string;
  };
  message: {
    conversation?: string;
    extendedTextMessage?: {
      text: string;
    };
    audioMessage?: {
      url: string;
    };
  };
  messageTimestamp?: number;
}

interface WazendWebhookPayload {
  event?: string;
  data: WazendMessage | { messages: WazendMessage[] }; // Union type to handle both formats
}

export async function webhookRoutes(server: FastifyInstance) {
  // Public webhook endpoint for Wazend
  server.post('/webhook/wazend', async (request: FastifyRequest<{ Body: WazendWebhookPayload }>, reply: FastifyReply) => {
    try {
      const payload = request.body;
      
      // Basic logging
      request.log.info({ msg: 'Webhook endpoint hit' });
      
      // Check if this is a message event (Evolution API standard is "messages.upsert")
      if (payload.event && payload.event !== 'messages.upsert') {
        console.log(`[WEBHOOK] Ignored event type: ${payload.event}`);
        return reply.status(200).send('ok');
      }

      // Extract message data handling both array and direct object formats
      let messageData: WazendMessage | undefined;

      // Type guard helper to check if data has messages array
      const hasMessagesArray = (data: any): data is { messages: WazendMessage[] } => {
        return data && Array.isArray(data.messages);
      };

      if (hasMessagesArray(payload.data) && payload.data.messages.length > 0) {
        messageData = payload.data.messages[0];
      } else if (payload.data && 'key' in (payload.data as any)) {
        // Assume payload.data is the message itself
        messageData = payload.data as WazendMessage;
      }

      if (!messageData) {
        console.log('[WEBHOOK] Ignored: Invalid payload structure or no messages');
        return reply.status(200).send('ok');
      }
      
      // Ignore messages from self
      if (messageData.key.fromMe) {
        console.log(`[WEBHOOK] Ignored: fromMe=${messageData.key.fromMe}`);
        return reply.status(200).send('ok');
      }

      // Determine Remote JID (Phone Number)
      // Prioritize remoteJidAlt if it's a standard WhatsApp number (@s.whatsapp.net), otherwise use remoteJid
      let remoteJid = messageData.key.remoteJid;
      if (messageData.key.remoteJidAlt && messageData.key.remoteJidAlt.includes('@s.whatsapp.net')) {
          remoteJid = messageData.key.remoteJidAlt;
      }

      // Check if it is a group
      const isGroup = messageData.isGroup || remoteJid.endsWith('@g.us');

      if (isGroup) {
          console.log(`[WEBHOOK] Ignored: Group message from ${remoteJid}`);
          return reply.status(200).send('ok');
      }

      const phoneNumber = remoteJid.split('@')[0] || ''; // Extract number (e.g., 51999999999)
      
      if (!phoneNumber) return reply.status(200).send('ok');
      
      // Extract text content or audio
      let text = '';

      if (messageData.message?.audioMessage?.url) {
          try {
              request.log.info({ msg: 'Audio detected, transcribing...' });
              text = await transcribeAudio(messageData.message.audioMessage.url);
              request.log.info({ msg: 'Audio transcribed', text });
          } catch (e) {
              request.log.error(e);
              text = ""; // Fail gracefully
          }
      } else {
          text = messageData.message?.conversation || messageData.message?.extendedTextMessage?.text || '';
      }

      text = text.trim();

      if (!text) return reply.status(200).send('ok');

      // 1. Linking Logic (#Mondi-XXXX)
      if (text.startsWith('#Mondi-')) {
        await handleLinking(text, phoneNumber, reply);
        return;
      }

      // 2. Chat Logic (If already linked)
      const user = await prisma.user.findUnique({
        where: { whatsappId: phoneNumber } 
      });

      if (user) {
        // Forward to AI Agent for RAG/Query
        const response = await processUserQuery(user.id, text, user.name || 'Vendedor');
        await sendWazendMessage(phoneNumber, response);
      } else {
        await sendWazendMessage(phoneNumber, "Hola, no reconozco este número. Por favor, regístrate en la web y envía tu código de vinculación (ej: #Mondi-1234).");
      }

      return reply.status(200).send('ok');

    } catch (error) {
      request.log.error(error);
      return reply.status(500).send('error');
    }
  });
}

async function handleLinking(code: string, phoneNumber: string, reply: FastifyReply) {
  try {
    console.log(`[LINKING] Attempting to link code: ${code} with phone: ${phoneNumber}`);

    // Find user with this pending verification code
    const user = await prisma.user.findFirst({
      where: { verificationCode: code }
    });

    if (!user) {
      console.log(`[LINKING] Invalid code: ${code}`);
      await sendWazendMessage(phoneNumber, "❌ Código inválido o expirado. Por favor genera uno nuevo en el panel web.");
      return reply.status(200).send('ok');
    }

    console.log(`[LINKING] Found user: ${user.email} (${user.name})`);

    // Link phone number and clear code
    await prisma.user.update({
      where: { id: user.id },
      data: {
        whatsappId: phoneNumber,
        verificationCode: null // Consume the code
      }
    });

    console.log(`[LINKING] User ${user.name} linked to ${phoneNumber}`);
    await sendWazendMessage(phoneNumber, `✅ ¡Vinculación exitosa! Hola ${user.name || 'Vendedor'}.`);
    
  } catch (error) {
    console.error("Linking Error:", error);
    await sendWazendMessage(phoneNumber, "❌ Error interno al vincular. Intenta más tarde.");
  }
}