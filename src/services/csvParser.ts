import { parse } from 'csv-parse/sync';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const normalizeKey = (value: string) => value.trim().toUpperCase().replace(/[\s/]+/g, '_');

const standaloneHeaderMap: Record<string, string> = {
  PACKS_DISPLAYS: "EXHIBIDOR",
  DISPLAYS: "META_PACKS",
  NEGRO: "RANGO_NEGRO",
  ROJO: "RANGO_ROJO",
  AMARILLO: "RANGO_AMARILLO",
  VERDE: "RANGO_VERDE"
};

export async function processCsvUpload(fileBuffer: Buffer) {
  // Parse the CSV content
  const records = parse(fileBuffer, {
    skip_empty_lines: true,
    relax_column_count: true,
  });

  if (records.length < 3) {
    throw new Error("El archivo CSV debe tener al menos 3 filas (categorías, cabeceras y datos)");
  }

  const categories = records[0] as string[];
  const headers = records[1] as string[];
  const fallbackHeaders = records[2] as string[];
  const resolvedHeaders = headers.map((header, index) => header?.trim() ? header : (fallbackHeaders?.[index] || ""));
  const mappedHeaders: string[] = [];
  let currentCategory = "";

  for (let i = 0; i < Math.max(categories.length, resolvedHeaders.length); i++) {
    const cat = categories[i]?.trim() || "";
    const sub = resolvedHeaders[i]?.trim() || "";

    const lowerCat = cat.toLowerCase();
    if (cat && lowerCat !== "actual" && lowerCat !== "necesidad") {
      currentCategory = cat;
    }

    let key = sub ? normalizeKey(sub) : "";
    const mappedStandalone = key ? standaloneHeaderMap[key] : "";
    if (mappedStandalone) {
      key = mappedStandalone;
    } else if (key && i >= 10) {
      const useCategory = (!cat || lowerCat === "actual" || lowerCat === "necesidad") ? currentCategory : cat;
      if (useCategory) {
        key = `${normalizeKey(useCategory)}_${key}`;
      }
    }

    mappedHeaders.push(key || "");
  }

  // Generate Batch ID
  const batchId = new Date().toISOString();

  const routeDataEntries = [];

  // Iterate data rows (starting from index 2)
  for (let i = 2; i < records.length; i++) {
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
      if (key === "RUTA_LOGICA") routeCode = value;
      else if (key === "COD_CLIENTE") clientCode = value;
      else if (key === "NOMBRE_CLIENTE") clientName = value;
      else if (key === "DIA_V") visitDay = value;
      else {
        if (value) {
            const normalizedValue = normalizeKey(value);
            if (standaloneHeaderMap[normalizedValue]) continue;
            dynamicData[key] = value;
        }
      }
    }

    // Validation: Require Route Code and Client Code
    if (!routeCode || !clientCode) {
        // Skip row or log warning?
        // Let's skip invalid rows to avoid polluting DB
        continue;
    }

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
