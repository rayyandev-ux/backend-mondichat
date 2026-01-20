
// @ts-nocheck
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const code = "MONDI-DEMO";
  console.log("Upserting MONDI-DEMO via RAW SQL...");
  
  // PostgreSQL syntax
  await prisma.$executeRawUnsafe(`
    INSERT INTO "RegistrationCode" ("id", "code", "isGlobal", "isUsed", "createdAt")
    VALUES (gen_random_uuid(), '${code}', true, false, NOW())
    ON CONFLICT ("code") 
    DO UPDATE SET "isGlobal" = true, "isUsed" = false;
  `);

  console.log(`Global code ${code} upserted successfully.`);
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
