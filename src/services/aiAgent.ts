import Groq from 'groq-sdk';
import OpenAI from 'openai';
import { PrismaClient } from '@prisma/client';
import type { RouteData } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import { Readable } from 'stream';

const prisma = new PrismaClient();

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

export async function transcribeAudio(audioUrl: string): Promise<string> {
    const tempFilePath = path.join(os.tmpdir(), `audio-${Date.now()}.ogg`);
    
    try {
        const response = await fetch(audioUrl);
        if (!response.ok || !response.body) throw new Error(`Failed to download audio: ${response.statusText}`);
        
        // Convert Web Stream to Node Stream
        // @ts-ignore
        const nodeStream = Readable.fromWeb(response.body);
        await pipeline(nodeStream, createWriteStream(tempFilePath));
        
        const transcription = await groq.audio.transcriptions.create({
            file: fs.createReadStream(tempFilePath),
            model: process.env.GROQ_AUDIO_MODEL || 'whisper-large-v3-turbo',
            language: 'es'
        });
        
        return transcription.text;
    } catch (error) {
        console.error("Transcription Error:", error);
        return ""; // Return empty string on error to avoid crashing flow, or handle upstream
    } finally {
        if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath);
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
            take: 300 // Limit to capture route context
        });

        if (routeData.length === 0) {
            return `⚠️ No hay información cargada para la ruta ${user.route}.`;
        }

        // Prepare Context
        const contextData = routeData.map((d: RouteData) => {
             // Simplify JSON data to string
             const dataStr = typeof d.data === 'object' ? JSON.stringify(d.data) : String(d.data);
             return `Cliente: ${d.clientName} (${d.clientCode}) - Visita: ${d.visitDay} - Info: ${dataStr}`;
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
Tu objetivo es ayudar al vendedor (${userName}) a gestionar su ruta (${user.route}) y maximizar ventas usando la metodología "PS R+N (Rojo + Negro)".
FECHA ACTUAL: ${todayDate}
META MÁXIMA DE CLIENTES EN ROJO+NEGRO (CUOTA): ${user.quotaPercentage ?? 50}%

METODOLOGÍA PS R+N (ROJO + NEGRO) - TABLA DE OBJETIVOS MENSUALES:
Analiza el "Info" de cada cliente para identificar su tipo de exhibidor y cantidad de packs comprados. Usa esta tabla para determinar su estado:

| TIPO DE EXHIBIDOR | NEGRO (0 Packs) | ROJO (Peligro) | AMARILLO (En Camino) | VERDE (Meta) |
|---|---|---|---|---|
| Exhibidor Kiwi 2 bandejas | 0 | 1 - 7 | 8 - 11 | 12+ |
| Exhibidor Kiwi 3 bandejas | 0 | 1 - 9 | 10 - 13 | 14+ |
| Lego Crystal x 6 cubos | 0 | 1 - 5 | 6 - 8 | 9+ |
| Lego Crystal x 9 cubos | 0 | 1 - 6 | 7 - 10 | 11+ |
| meGAKIWE | 0 | 1 - 19 | 20 - 29 | 30+ |

ESTRATEGIA PRINCIPAL: ¡SALIR DE ROJO Y NEGRO!
Tu misión NO es solo vender a los que están en cero, sino mover a los clientes de la zona de peligro (⚫🔴) a la zona productiva (🟡🟢).

INDICADOR CLAVE (KPI): % R+N = (Total Clientes en Negro + Total Clientes en Rojo) / Total Clientes de la Ruta.
- Si el % R+N es MAYOR a la Cuota (${user.quotaPercentage ?? 50}%), el vendedor está EN PELIGRO (Fuera de Cuota).
- Si el % R+N es MENOR o IGUAL a la Cuota, el vendedor va BIEN (Dentro de Cuota).

INSTRUCCIONES INTELIGENTES:
1. **Análisis Profundo**: Tienes acceso a TODA la información de la ruta en "INFORMACIÓN DE LA RUTA". Úsala para responder CUALQUIER pregunta.
2. **Cálculo de Estado**: Calcula el color de CADA cliente según la tabla.
3. **Cálculo de KPI**: Si el usuario pide un resumen, "cómo voy" o "avance", SIEMPRE calcula:
   - Total Clientes.
   - Total en ⚫+🔴.
   - Porcentaje resultante.
   - Estado frente a la Cuota (${user.quotaPercentage ?? 50}%).
4. **Priorización**: Al listar clientes prioritarios, enfócate en aquellos en ⚫ o 🔴 que necesitan "salir del pozo".
5. **Respuesta General**: Responde dudas generales sobre datos.
6. **Reportes**: Si hay incidencias, usa "REPORT_DETECTED: [Resumen]".
7. **LÍMITE DE LISTAS**: Máximo 20 clientes. Si hay más, "...y [X] más. ¿Quieres ver el resto? Dime 'ver más'".
8. **Paginación**: Muestra siguientes 20 si piden "ver más".

INFORMACIÓN DE LA RUTA:
${contextData}`
        };

        const messages = [
            systemMessage,
            ...history.map(msg => ({ role: msg.role, content: msg.content })),
            { role: "user" as const, content: query }
        ];

        const completion = await openai.chat.completions.create({
            messages: messages,
            model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
            temperature: 0.3,
            max_tokens: 1000 // Increased for larger lists
        });

        const responseText = completion.choices[0]?.message?.content || "Lo siento, no pude procesar tu solicitud.";

        // Update history
        const newHistory = [...history, { role: 'user' as const, content: query }, { role: 'assistant' as const, content: responseText }];
        // Keep last 10 turns (20 messages)
        if (newHistory.length > 20) {
            newHistory.splice(0, newHistory.length - 20);
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