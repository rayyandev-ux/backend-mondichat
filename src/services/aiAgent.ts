import Groq from 'groq-sdk';
import OpenAI from 'openai';
import { PrismaClient } from '@prisma/client';
import type { RouteData } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import pino from 'pino';

const prisma = new PrismaClient();
const logger = pino({ level: 'silent' }); // Silent logger for Baileys

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// We now accept the full message object to handle decryption
export async function transcribeAudio(message: any): Promise<string> {
    const tempFilePath = path.join(os.tmpdir(), `audio-${Date.now()}.ogg`);
    
    try {
        console.log(`[AI-AGENT] Decrypting and downloading audio from WhatsApp message...`);
        
        // Use Baileys to download and decrypt the media
        // We construct a minimal message object if needed, but passing the raw one is best
        // Note: Wazend webhook structure might be slightly different, but usually 'message' matches.
        
        // Ensure we have the right structure for downloadMediaMessage
        // It expects { key: ..., message: { audioMessage: ... } } or just the message content depending on usage.
        // Actually downloadMediaMessage expects the full WebMessageInfo or the message content.
        // Let's try passing the whole message object we received from webhook.
        
        const buffer = await downloadMediaMessage(
            message,
            'buffer',
            { }
        ) as Buffer;

        if (!buffer || buffer.length === 0) throw new Error("Decrypted audio buffer is empty");

        console.log(`[AI-AGENT] Audio decrypted successfully! Size: ${buffer.length} bytes`);
        
        fs.writeFileSync(tempFilePath, buffer);
        console.log(`[AI-AGENT] Saved decrypted audio to: ${tempFilePath}`);
        console.log(`[AI-AGENT] Sending to Groq (whisper-large-v3-turbo)...`);

        if (!process.env.GROQ_API_KEY) {
            throw new Error("GROQ_API_KEY is missing. Cannot use Groq.");
        }

        // Trick: Sometimes Groq/Whisper works better if we explicitly call it .mp3 or .wav
        // even if the content is OGG. But let's try standard approach first since we have clean audio now.
        // Actually, to align with "ContaPRO" logic which works, we send the file directly.
        
        const transcription = await groq.audio.transcriptions.create({
            file: fs.createReadStream(tempFilePath),
            model: "whisper-large-v3-turbo",
            language: "es",
        });

        console.log(`[AI-AGENT] Groq Whisper Success! Text: "${transcription.text.substring(0, 50)}..."`);
        
        return transcription.text || "";

    } catch (error: any) {
        console.error("Transcription/Decryption Error:", error.message);
        // Fallback: If decryption fails (maybe keys are missing), log it clearly
        if (error.message.includes('missing')) {
             console.error("POSSIBLE CAUSE: The webhook payload might be missing 'mediaKey'. Check Wazend configuration.");
        }
        return "";
    } finally {
        if (fs.existsSync(tempFilePath)) {
            try { fs.unlinkSync(tempFilePath); } catch (e) {}
        }
    }
}

const conversationHistory = new Map<string, Array<{role: 'user' | 'assistant', content: string}>>();

export async function processUserQuery(userId: string, query: string, userName: string): Promise<string> {
    console.log(`[AI-AGENT] Processing query for ${userName} (${userId}): "${query}"`);
    try {
        // 1. Get User Route
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { route: true, quotaPercentage: true }
        });

        if (!user || !user.route) {
            return "⚠️ No tienes una ruta asignada. Por favor contacta a tu supervisor.";
        }

        // 2. Get Route Data (ALWAYS FRESH)
        const routeData = await prisma.routeData.findMany({
            where: { routeCode: user.route },
            orderBy: { uploadedAt: 'desc' },
            take: 800 // Increased to ensure we cover full week (Mon-Sat)
        });

        if (routeData.length === 0) {
            return `⚠️ No hay información cargada para la ruta ${user.route}.`;
        }

        // Prepare Context
        // Optimization: Don't map all data immediately. Let's just provide raw summary if too large.
        // Actually, for "intelligence", we need to provide data but instruct LLM to be smart.
        // To improve speed/intelligence:
        // 1. Filter out empty/useless fields in stringify.
        // 2. Limit context to what's RELEVANT (e.g. today +/- 2 days if query implies schedule).
        // But for now, let's just make the prompt cleaner.

        const contextData = routeData.map((d: RouteData) => {
             // 1. Raw stringify
             let dataStr = typeof d.data === 'object' ? JSON.stringify(d.data) : String(d.data);
             
             // 2. COMPRESSION: Aggressive shortening to maximize context window
             dataStr = dataStr
                .replace(/[{}"]/g, '') // Remove JSON noise
                // Products
                .replace(/Kiwi 2/gi, "K2").replace(/Kiwi 3/gi, "K3")
                .replace(/Lego 6/gi, "L6").replace(/Lego 9/gi, "L9")
                .replace(/meGAKIWE/gi, "MK")
                // Metrics
                .replace(/_ACT/gi, "=A").replace(/_NEC/gi, "=F").replace(/_META/gi, "=M")
                // Separators
                .replace(/,/g, ' '); // Space separator for compactness

             return `[${d.visitDay ? d.visitDay.substring(0,3) : '???'}] ${d.clientName} (${d.clientCode}): ${dataStr}`;
        }).join('\n');
        
        // 3. LLM Call (OpenAI)
        if (!process.env.OPENAI_API_KEY) {
             console.warn("OPENAI_API_KEY not set.");
        }

        const todayDate = new Date().toLocaleDateString('es-PE', { timeZone: 'America/Lima', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

        // Retrieve history
        const history = conversationHistory.get(userId) || [];
        
        // Construct messages array
        const systemMessage = {
            role: "system" as const,
            content: `Eres MondiAI, el asistente virtual de MondiChat para vendedores.
Tu objetivo es ayudar al vendedor (${userName}) a gestionar su ruta (${user.route}) y maximizar ventas.
FECHA ACTUAL: ${todayDate}
CUOTA R+N: ${user.quotaPercentage ?? 50}%

### 🧠 CEREBRO ACTIVO (Instrucciones de Pensamiento):
- **NO USES MEMORIA VIEJA**: Responde basándote ÚNICAMENTE en la "INFORMACIÓN DE LA RUTA" proporcionada abajo y en la pregunta actual del usuario.
- **VELOCIDAD**: Sé conciso. Ve al grano.
- **INTELIGENCIA**: 
  - Si el usuario pregunta "quién toca hoy", busca en la lista el día actual.
  - Si pregunta por un cliente específico, búscalo por nombre o código.
  - Si ves inconsistencias (ej. 0 packs pero color verde), CORRIGE al color NEGRO.

### � DECODIFICADOR DE DATOS (Optimizados):
- **PRODUCTOS**: K2=Kiwi 2, K3=Kiwi 3, L6=Lego 6, L9=Lego 9, MK=meGAKIWE.
- **METRICAS**: A=Packs Actuales (Ventas), F=Falta para siguiente nivel, M=Meta.
- **DÍAS**: Lun=Lunes, Mar=Martes, Mié=Miércoles, Jue=Jueves, Vie=Viernes, Sáb=Sábado.

### 📊 REGLAS DE NEGOCIO (R+N):
- REGLA DE ORO: Si **A=0** (0 Packs) -> ES NEGRO ⚫.
- REGLA DE PLATA: Usa el valor 'A' para determinar el color según la tabla:

| TIPO | ⚫ (A=0) | 🔴 | 🟡 | 🟢 |
|---|---|---|---|---|
| K2 | 0 | 1-7 | 8-11 | 12+ |
| K3 | 0 | 1-9 | 10-13 | 14+ |
| L6 | 0 | 1-5 | 6-8 | 9+ |
| L9 | 0 | 1-6 | 7-10 | 11+ |
| MK | 0 | 1-19 | 20-29 | 30+ |

### 📝 FORMATO DE RESPUESTA (ESTRICTO):
1. **Paginación MANDATORIA**: 
   - **MÁXIMO 10 CLIENTES** por mensaje. ¡CUÉNTALOS!
   - Si hay más, añade al final: "🔽 *Escribe 'ver más' para los siguientes.*"

2. **Estilo Visual (ESPACIADO)**:
   - ⛔ PROHIBIDO usar listas numeradas (1., 2.).
   - **IMPORTANTE**: Deja SIEMPRE una línea en blanco entre cada cliente para que no se vea aglomerado.
   
   USA este formato de lista EXACTO:
   * [Nombre Cliente]
     └ 📅 [Día] | 🎨 [Emoji] [Color] ([N] Packs)
     └ 🚀 Falta: [N] para subir

   * [Siguiente Cliente]...

   (Nota el espacio vacío entre clientes)

3. **Resúmenes y Listas**:
   - Usa siempre viñetas (-) para listar días o items simples.
   - Ejemplo:
     - Lunes: 10 clientes
     - Martes: 8 clientes

4. **Cierre Cálido (MANDATORIO)**:
   - Termina SIEMPRE con una frase breve, cálida y motivadora mencionando a "MondiChat".
   - Ejemplos: "¡MondiChat te acompaña en tu ruta! 🚀", "¡Vamos por más con MondiChat! 💪", "Tu aliado digital, MondiChat."

INFORMACIÓN DE LA RUTA (Datos en Tiempo Real):
${contextData}`
        };

        const messages = [
            systemMessage,
            ...history.map(msg => ({ role: msg.role, content: msg.content })),
            { role: "user" as const, content: query }
        ];

        console.log(`[AI-AGENT] Context Data Length: ${contextData.length} chars`);
        
        const completion = await openai.chat.completions.create({
            messages: messages,
            model: "gpt-4o-mini", // FORCE SWITCH to stable model
            temperature: 0, // Now we can use 0 for stability
            max_completion_tokens: 2000 // Allow longer response
        });

        console.log("[AI-AGENT] OpenAI Response Status:", completion.choices[0]?.finish_reason);

        const responseText = completion.choices[0]?.message?.content || "Lo siento, no pude procesar tu solicitud.";

        // Update history
        const newHistory = [...history, { role: 'user' as const, content: query }, { role: 'assistant' as const, content: responseText }];
        // Keep last 25 turns (50 messages) to maintain context during demos
        if (newHistory.length > 50) {
            newHistory.splice(0, newHistory.length - 50);
        }
        conversationHistory.set(userId, newHistory);

        // Check for REPORT_DETECTED
        if (responseText.includes("REPORT_DETECTED:")) {
             const parts = responseText.split("REPORT_DETECTED:");
             const reportContent = parts[1] ? parts[1].trim() : "Reporte vacío";
             // Save report
             await prisma.report.create({
                 data: {
                     content: reportContent,
                     userId: userId,
                     status: 'pending'
                 }
             });
             // Return a clean message to user (remove the tag)
             return `📝 Reporte guardado: "${reportContent}". ¡Gracias!`;
        }

        return responseText;

    } catch (error) {
        console.error("AI Agent Error:", error);
        return "❌ Tuve un problema procesando tu consulta. Intenta de nuevo más tarde.";
    }
}