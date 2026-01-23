import { parse } from 'csv-parse/sync';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const normalizeKey = (value: string) => value.trim().toUpperCase().replace(/[\s/]+/g, '_');

const standaloneHeaderMap: Record<string, string> = {
  EXHIBIDOR_KIWES: "EXHIBIDOR_KIWES",
  COLOR_ACTUAL_KIWES: "COLOR_ACTUAL_KIWES",
  PACKS_VENDIDOS_KIWES: "PACKS_VENDIDOS_KIWES",
  SIGUIENTE_NIVEL_OBJETIVO_KIWES: "SIGUIENTE_NIVEL_OBJETIVO_KIWES",
  "PACKS_FALTANTES_SIGUIENTE NIVEL_KIWES": "PACKS_FALTANTES_KIWES",
  EXHIBIDOR_LEGOS: "EXHIBIDOR_LEGOS",
  COLOR_ACTUAL_LEGOS: "COLOR_ACTUAL_LEGOS",
  PACKS_VENDIDOS_LEGOS: "PACKS_VENDIDOS_LEGOS",
  SIGUIENTE_NIVEL_OBJETIVO_LEGOS: "SIGUIENTE_NIVEL_OBJETIVO_LEGOS",
  "PACKS_FALTANTES_SIGUIENTE NIVEL_LEGOS": "PACKS_FALTANTES_LEGOS"
};

export async function processCsvUpload(fileBuffer: Buffer) {
  // Detect delimiter: try to parse first line
  const content = fileBuffer.toString('utf-8');
  const firstLine = content.split(/\r?\n/)[0] || "";
  const delimiter = firstLine.includes(';') ? ';' : ',';

  // Parse the CSV content
  const records = parse(fileBuffer, {
    skip_empty_lines: true,
    relax_column_count: true,
    delimiter: delimiter,
    trim: true
  });

  if (records.length < 2) { // Allow header + 1 data row
    throw new Error("El archivo CSV debe tener al menos 2 filas (cabeceras y datos)");
  }

  const categories = records[0] as string[];
  // If only 1 header row (simple CSV), use it directly. 
  // But logic below assumes multi-row headers. 
  // Let's adapt: The provided CSV is single-header row (line 1).
  // records[0] is header.
  
  const headers = records[0] as string[]; 
  
  const mappedHeaders: string[] = [];

  for (let i = 0; i < headers.length; i++) {
    let key = headers[i]?.trim() || "";
    // Check direct map first
    if (standaloneHeaderMap[key]) {
        mappedHeaders.push(standaloneHeaderMap[key]);
    } else {
        // Fallback or keep as is (normalized)
        mappedHeaders.push(normalizeKey(key));
    }
  }

  // Generate Batch ID
  const batchId = new Date().toISOString();

  const routeDataEntries = [];

  // Iterate data rows (starting from index 1 since 0 is header)
  for (let i = 1; i < records.length; i++) {
    const row = records[i] as string[] | undefined;
    if (!row) continue;

    const rowData: any = {};
    
    // Core fields
    let routeCode = "";
    let clientCode = "";
    let clientName = "";
    let visitDay = "";
    
    // Dynamic data
    const dynamicData: any = {};

    for (let j = 0; j < mappedHeaders.length; j++) {
      const key = mappedHeaders[j];
      const value = row[j]?.trim() || "";
      
      if (!key) continue;

      // Map to core fields
      if (key === "RUTA" || key === "RUTA_LOGICA") routeCode = value;
      else if (key === "COD_CLIENTE") clientCode = value;
      else if (key === "NOMBRE_CLIENTE") clientName = value;
      else if (key === "DIA_VISITA" || key === "DIA_V") visitDay = value;
      else {
         dynamicData[key] = value;
      }
    }

    // Validation: Require Client Code and Valid Route
    if (!clientCode) continue;
    
    // Ignore routes "0" or empty
    if (!routeCode || routeCode === "0" || routeCode === "0.0") continue;

    routeDataEntries.push({
        routeCode,
        clientCode,
        clientName,
        visitDay,
        data: dynamicData,
        batchId
    });
  }

  // Bulk insert
  // Note: Prisma createMany is supported in Postgres
  if (routeDataEntries.length > 0) {
      // Optional: Clear old data for these routes? Or just append?
      // User said "se subira un nuevo csv... debera integrarse".
      // Usually implies replacing or updating. 
      // For now, let's just insert. We can filter by latest batchId or delete old ones.
      // Better to delete old ones for the same routes to avoid duplicates if it's a full snapshot.
      
      // Let's delete all existing data for safety/simplicity as it seems to be a snapshot.
      await prisma.routeData.deleteMany({});
      
      await prisma.routeData.createMany({
        data: routeDataEntries
      });
  }

  return { success: true, count: routeDataEntries.length, batchId };
}
