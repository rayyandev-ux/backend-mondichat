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
        
        const transcription = await groq.audio.transcriptions.create({
            file: fs.createReadStream(tempFilePath),
            model: "whisper-large-v3-turbo",
            language: "es",
        });

        console.log(`[AI-AGENT] Groq Whisper Success! Text: "${transcription.text.substring(0, 50)}..."`);
        
        return transcription.text || "";

    } catch (error: any) {
        console.error("Transcription/Decryption Error:", error.message);
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
const paginationState = new Map<string, { items: string[]; index: number }>();

const parseNumber = (value: unknown) => {
    if (value === null || value === undefined) return null;
    const num = Number(String(value).replace(/[^\d.-]/g, ''));
    return Number.isFinite(num) ? num : null;
};

const getExhibidorType = (data: Record<string, any>) => {
    const k = data.EXHIBIDOR_KIWES;
    const l = data.EXHIBIDOR_LEGOS;
    if (k && k !== "NO" && l && l !== "NO") return "MIXTO";
    if (k && k !== "NO") return "KIWE";
    if (l && l !== "NO") return "LEGO";
    return "N/D";
};

const getDefaultThresholds = (type: string | null) => {
    if (type === "K2") return { rojoMin: 1, amarilloMin: 8, verdeMin: 12 };
    if (type === "K3") return { rojoMin: 1, amarilloMin: 10, verdeMin: 14 };
    if (type === "L6") return { rojoMin: 1, amarilloMin: 6, verdeMin: 9 };
    if (type === "L9") return { rojoMin: 1, amarilloMin: 7, verdeMin: 11 };
    if (type === "MK") return { rojoMin: 1, amarilloMin: 20, verdeMin: 30 };
    return { rojoMin: 1, amarilloMin: 8, verdeMin: 12 };
};

const computeColorInfo = (packsActual: number | null, thresholds: { rojoMin: number; amarilloMin: number; verdeMin: number }) => {
    if (packsActual === null) return { color: "N/D", falta: null };
    if (packsActual <= 0) return { color: "NEGRO", falta: Math.max(0, thresholds.rojoMin - packsActual) };
    if (packsActual >= thresholds.verdeMin) return { color: "VERDE", falta: 0 };
    if (packsActual >= thresholds.amarilloMin) return { color: "AMARILLO", falta: Math.max(0, thresholds.verdeMin - packsActual) };
    return { color: "ROJO", falta: Math.max(0, thresholds.amarilloMin - packsActual) };
};

const colorEmojiMap: Record<string, string> = {
    NEGRO: "⚫",
    ROJO: "🔴",
    AMARILLO: "🟡",
    VERDE: "🟢",
    "N/D": "⚪"
};

const normalizeText = (value: string) =>
    value
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

const resolveDayFilter = (queryText: string) => {
    const days = ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"];
    for (const day of days) {
        if (queryText.includes(day)) return day;
    }
    if (queryText.includes("hoy")) {
        const today = new Date().toLocaleDateString('es-PE', { weekday: 'long', timeZone: 'America/Lima' });
        return normalizeText(today);
    }
    return null;
};

const resolveColorFilter = (queryText: string) => {
    if (queryText.includes("negro")) return "NEGRO";
    if (queryText.includes("rojo")) return "ROJO";
    if (queryText.includes("amarillo")) return "AMARILLO";
    if (queryText.includes("verde")) return "VERDE";
    return null;
};

const isMoreQuery = (queryText: string) => /ver\s+mas/.test(queryText);

const isListIntent = (queryText: string) => {
    const triggers = ["quien toca", "quien toca hoy", "toca hoy", "lista", "clientes", "dame", "muestrame", "muéstrame", "rojo", "negro", "amarillo", "verde", "prioridad", "prioritarios", "faltan", "falta", "faltantes", "orden", "ordenados", "priorizar"];
    return triggers.some(trigger => queryText.includes(trigger));
};

const formatClientBlock = (client: {
    name: string;
    day: string;
    exhibidor: string;
    color: string;
    packs: string;
    falta: string;
    clientCode: string;
}) => {
    const emoji = colorEmojiMap[client.color] || "⚪";
    return `* ${client.name} (Código: ${client.clientCode})\n  └ 🏷️ Exhibidor: ${client.exhibidor}\n  └ 📅 ${client.day} | 🎨 ${emoji} ${client.color} (${client.packs} Packs)\n  └ 🚀 Falta: ${client.falta} para subir`;
};

const buildPaginatedResponse = (items: string[], startIndex: number, customPageSize?: number) => {
    const pageSize = customPageSize || 10;
    const slice = items.slice(startIndex, startIndex + pageSize);
    const nextIndex = startIndex + slice.length;
    const hasMore = nextIndex < items.length;
    const footer = hasMore ? `\n\n🔽 *Escribe 'ver más' para los siguientes.*` : "";
    const closing = `\n\n¡MondiChat te acompaña en tu ruta! 🚀`;
    return {
        text: slice.join("\n\n") + footer + closing,
        nextIndex,
        hasMore
    };
};

export async function processUserQuery(userId: string, query: string, userName: string, isAudio: boolean = false): Promise<string> {
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

        const clientSummaries = routeData.map((d: RouteData) => {
            const data = (d.data || {}) as Record<string, any>;
            
            // Extract Kiwe Info
            const kExhibidor = data.EXHIBIDOR_KIWES && data.EXHIBIDOR_KIWES !== "NO" ? data.EXHIBIDOR_KIWES : null;
            const kColor = data.COLOR_ACTUAL_KIWES && data.COLOR_ACTUAL_KIWES !== "NO" ? data.COLOR_ACTUAL_KIWES : null;
            const kPacks = parseNumber(data.PACKS_VENDIDOS_KIWES);
            const kFalta = parseNumber(data.PACKS_FALTANTES_KIWES);
            const kMeta = data.SIGUIENTE_NIVEL_OBJETIVO_KIWES && data.SIGUIENTE_NIVEL_OBJETIVO_KIWES !== "NO" ? data.SIGUIENTE_NIVEL_OBJETIVO_KIWES : null;

            // Extract Lego Info
            const lExhibidor = data.EXHIBIDOR_LEGOS && data.EXHIBIDOR_LEGOS !== "NO" ? data.EXHIBIDOR_LEGOS : null;
            const lColor = data.COLOR_ACTUAL_LEGOS && data.COLOR_ACTUAL_LEGOS !== "NO" ? data.COLOR_ACTUAL_LEGOS : null;
            const lPacks = parseNumber(data.PACKS_VENDIDOS_LEGOS);
            const lFalta = parseNumber(data.PACKS_FALTANTES_LEGOS);
            const lMeta = data.SIGUIENTE_NIVEL_OBJETIVO_LEGOS && data.SIGUIENTE_NIVEL_OBJETIVO_LEGOS !== "NO" ? data.SIGUIENTE_NIVEL_OBJETIVO_LEGOS : null;

            // Determine Primary (if mixed, show both or primary?)
            // For simplicity in chat list, we combine if both exist.
            let exhibidorText = "N/D";
            let packsText = "N/D";
            let colorText = "N/D";
            let faltaText = "N/D";
            let faltaDisplay = "N/D";
            let metaText = "N/D";

            if (kExhibidor && lExhibidor) {
                exhibidorText = `Kiwe: ${kExhibidor} | Lego: ${lExhibidor}`;
                packsText = `K:${kPacks} L:${lPacks}`;
                colorText = `K:${kColor} L:${lColor}`;
                faltaText = `Kiwe ${kExhibidor}: ${kFalta} | Lego ${lExhibidor}: ${lFalta}`;
                faltaDisplay = `Kiwe ${kExhibidor} ${kFalta ?? 0} | Lego ${lExhibidor} ${lFalta ?? 0}`;
                metaText = `K:${kMeta} L:${lMeta}`;
            } else if (kExhibidor) {
                exhibidorText = kExhibidor;
                packsText = String(kPacks ?? 0);
                colorText = kColor ?? "N/D";
                faltaText = `${kExhibidor}: ${kFalta ?? 0}`;
                faltaDisplay = `${kFalta ?? 0} (${kExhibidor})`;
                metaText = kMeta ?? "N/D";
            } else if (lExhibidor) {
                exhibidorText = lExhibidor;
                packsText = String(lPacks ?? 0);
                colorText = lColor ?? "N/D";
                faltaText = `${lExhibidor}: ${lFalta ?? 0}`;
                faltaDisplay = `${lFalta ?? 0} (${lExhibidor})`;
                metaText = lMeta ?? "N/D";
            }

            const dayLabel = d.visitDay ? d.visitDay.substring(0,3) : '???';
            const clientName = d.clientName || 'Cliente sin nombre';
            const clientCode = d.clientCode || 'N/D';

            return {
                dayLabel,
                fullDay: d.visitDay || 'N/D',
                clientName,
                clientCode,
                exhibidorText,
                packsText,
                faltaText,
                faltaDisplay,
                color: colorText,
                metaText,
                tipoText: getExhibidorType(data)
            };
        });

        const contextData = clientSummaries.map((summary) => {
            return `[${summary.dayLabel}] ${summary.clientName} (${summary.clientCode}): EXHIBIDOR=${summary.exhibidorText} | TIPO=${summary.tipoText} | PACKS=${summary.packsText} | COLOR=${summary.color} | FALTA=${summary.faltaText} | META=${summary.metaText}`;
        }).join('\n');

        const normalizedQuery = normalizeText(query);
        if (isMoreQuery(normalizedQuery)) {
            const state = paginationState.get(userId);
            if (state && state.items.length > 0) {
                const page = buildPaginatedResponse(state.items, state.index, 10); // Default 10 for "ver más"
                state.index = page.nextIndex;
                paginationState.set(userId, state);
                if (!page.hasMore) {
                    paginationState.delete(userId);
                }
                return page.text;
            }
            return "No hay más clientes en la lista actual. ¡MondiChat te acompaña en tu ruta! 🚀";
        }

        const listRequested = !isAudio && isListIntent(normalizedQuery);
        const dayFilter = resolveDayFilter(normalizedQuery);
        const colorFilter = resolveColorFilter(normalizedQuery);

        // Check for requested quantity (e.g. "2 clientes", "5 primeros", "dos clientes")
        const quantityMatchDigit = normalizedQuery.match(/(\d+)\s+(?:clientes|registros|primeros|ultimos)/);
        let requestedQuantity = (quantityMatchDigit && quantityMatchDigit[1]) ? parseInt(quantityMatchDigit[1], 10) : null;

        if (!requestedQuantity) {
             const wordToNum: Record<string, number> = {
                 "un": 1, "uno": 1, "una": 1, "dos": 2, "tres": 3, "cuatro": 4, 
                 "cinco": 5, "seis": 6, "siete": 7, "ocho": 8, "nueve": 9, "diez": 10
             };
             const quantityMatchWord = normalizedQuery.match(/(un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+(?:clientes|registros|primeros|ultimos)/);
             if (quantityMatchWord && quantityMatchWord[1]) {
                 requestedQuantity = wordToNum[quantityMatchWord[1]] || null;
             }
        }

        if (listRequested || (dayFilter && !isAudio) || (colorFilter && !isAudio)) {
            const filtered = clientSummaries.filter(summary => {
                const dayMatch = dayFilter ? normalizeText(summary.fullDay).includes(dayFilter) : true;
                const colorMatch = colorFilter ? summary.color === colorFilter : true;
                return dayMatch && colorMatch;
            });

            if (filtered.length === 0) {
                return "No encontré clientes con ese criterio. ¡MondiChat te acompaña en tu ruta! 🚀";
            }

            const items = filtered.map(summary =>
                formatClientBlock({
                    name: summary.clientName,
                    day: summary.dayLabel,
                    exhibidor: summary.exhibidorText,
                    color: summary.color,
                    packs: summary.packsText,
                    falta: summary.faltaDisplay,
                    clientCode: summary.clientCode
                })
            );

            // If a specific quantity was requested, use it as the page size for the first page
            // OR simply slice the items if they just want "top N"
            const pageSize = requestedQuantity || 10;

            paginationState.set(userId, { items, index: 0 });
            const page = buildPaginatedResponse(items, 0, pageSize);
            paginationState.set(userId, { items, index: page.nextIndex });
            if (!page.hasMore) {
                paginationState.delete(userId);
            }
            return page.text;
        }
        
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
  - Usa SIEMPRE los campos EXHIBIDOR, PACKS, COLOR y FALTA del contexto, no recalcules.

### 🧩 DATOS CALCULADOS:
- EXHIBIDOR, TIPO, PACKS, COLOR, FALTA y META ya vienen listos en la información.
- Si EXHIBIDOR es N/D, indícalo y no inventes.

### 📊 REGLAS DE NEGOCIO (R+N):
- Usa el COLOR del contexto. Solo si faltara, responde "N/D".

### 📝 FORMATO DE RESPUESTA (ESTRICTO):
1. **Paginación MANDATORIA**: 
   - **MÁXIMO 10 CLIENTES** por mensaje. ¡CUÉNTALOS!
   - Si hay más, añade al final: "🔽 *Escribe 'ver más' para los siguientes.*"

2. **Estilo Visual (ESPACIADO)**:
   - ⛔ PROHIBIDO usar listas numeradas (1., 2.).
   - **IMPORTANTE**: Deja SIEMPRE una línea en blanco entre cada cliente para que no se vea aglomerado.
   
   USA este formato de lista EXACTO:
  * [Nombre Cliente]
    └ 🏷️ Exhibidor: [Exhibidor]
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

5. **Ejemplos de consulta**:
   - "¿Qué color tiene [cliente]?"
   - "¿Quién toca hoy?"
   - "¿Cuánto me falta para subir de color?"
   - "Dame los rojos de mi ruta"

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
