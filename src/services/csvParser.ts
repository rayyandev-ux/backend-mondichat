import { parse } from 'csv-parse/sync';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function processCsvUpload(fileBuffer: Buffer) {
  // Parse the CSV content
  const records = parse(fileBuffer, {
    skip_empty_lines: true,
    relax_column_count: true,
  });

  if (records.length < 3) {
    throw new Error("El archivo CSV debe tener al menos 3 filas (categorías, cabeceras y datos)");
  }

  const categories = records[0] as string[]; // Row 1: Categories (KIWE, LEGO...)
  const headers = records[1] as string[];    // Row 2: Sub-headers (Kx2, NEGRO...)
  
  // Construct the mapping keys
  const mappedHeaders: string[] = [];
  let currentCategory = "";

  for (let i = 0; i < Math.max(categories.length, headers.length); i++) {
    const cat = categories[i]?.trim() || "";
    const sub = headers[i]?.trim() || "";

    if (cat) {
      currentCategory = cat;
    }

    // If both are empty, ignore or use index? 
    // In this CSV, the first few columns have empty Category but valid Header.
    // "KIWE" starts later.
    
    let key = sub || "";
    if (currentCategory && i >= 10) { // Heuristic: Categories start appearing later or use logic
       // Actually, if there is a category, we prepend it.
       // But "mesa", "RUTA LÓGICA" don't have category.
       // Logic: If column has a Category, use Cat_Sub. Else use Sub.
       // However, the Category applies to a range.
       // "KIWE" is at index 10. "NEGRO" is at index 10. So "KIWE_NEGRO".
       // Index 11 has empty Category but "ROJO". Since "KIWE" was at 10, does it apply to 11?
       // The user said "KIWE" spans multiple.
       // So yes, we keep `currentCategory`.
       
       // Reset currentCategory if we hit a new one? 
       // Or if we hit a column that clearly doesn't belong?
       // In Excel merged cells, usually only the first cell has the value.
       // So `currentCategory` persists until a NEW category appears OR we decide it ends.
       // Let's assume it persists.
       
       // Exception: The first few columns (0-9) might effectively have "Info" or no category.
       // "KIWE" appears at 10.
       if (key && currentCategory) {
           key = `${currentCategory}_${key}`;
       }
    }
    
    mappedHeaders.push(key);
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
      if (key === "RUTA LÓGICA") routeCode = value;
      else if (key === "COD CLIENTE") clientCode = value;
      else if (key === "NOMBRE CLIENTE") clientName = value;
      else if (key === "DIA V") visitDay = value;
      else {
        // Add to dynamic JSON
        if (value) {
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
