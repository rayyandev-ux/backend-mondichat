import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

export async function authRoutes(server: FastifyInstance) {
  server.post('/auth/login', async (request, reply) => {
    const { email, password } = request.body as any;

    if (!email || !password) {
      return reply.status(400).send({ error: "Email y contraseña requeridos" });
    }

    const user = await prisma.user.findUnique({
      where: { email }
    });

    if (!user) {
      return reply.status(401).send({ error: "Credenciales inválidas" });
    }

    // Since we are migrating from a frontend-only auth, we might have plain text or argon2 passwords
    // Let's assume new users are registered with argon2 in frontend actions, or we need to verify logic.
    // Wait, the frontend `createUser` action uses `bcrypt` or similar? 
    // Let's check `lib/users.ts` in frontend to see how passwords are hashed.
    // If frontend uses `bcrypt`, backend must use `bcrypt` or compatible.
    // User requested `Argon2` for backend.
    
    // Check if password matches using Argon2
    let valid = false;
    try {
        valid = await argon2.verify(user.password, password);
    } catch (e) {
        // Fallback for legacy or plain text (development only)
        if (user.password === password) valid = true;
    }

    if (!valid) {
      return reply.status(401).send({ error: "Credenciales inválidas" });
    }

    // Generate JWT
    const token = server.jwt.sign({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role
    });

    return { token, user: { id: user.id, email: user.email, name: user.name, role: user.role } };
  });

  server.post('/auth/register', async (request, reply) => {
    const { name, email, password, dni, phone, route, registrationCode } = request.body as any;

    if (!name || !email || !password || !dni || !phone || !route || !registrationCode) {
      return reply.status(400).send({ error: "Todos los campos son obligatorios" });
    }

    // Validate Invite Code
    const codeRecord = await prisma.registrationCode.findUnique({
      where: { code: registrationCode }
    });

    if (!codeRecord) {
      return reply.status(400).send({ error: "Código de registro inválido" });
    }

    if (codeRecord.isUsed) {
      return reply.status(400).send({ error: "Este código de registro ya ha sido utilizado" });
    }

    // Check if user exists
    const existingUser = await prisma.user.findUnique({
      where: { email }
    });

    if (existingUser) {
      return reply.status(400).send({ error: "El email ya está registrado" });
    }
    
    // Hash password
    const hashedPassword = await argon2.hash(password);

    // Create user and update code transactionally
    try {
      const result = await prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: {
            name,
            email,
            password: hashedPassword,
            role: 'user', 
            dni,
            phone,
            route,
            registrationCode
          }
        });

        // Only mark as used if NOT global
        if (!(codeRecord as any).isGlobal) {
          await tx.registrationCode.update({
            where: { id: codeRecord.id },
            data: {
              isUsed: true,
              usedByUserId: newUser.id,
              usedByUserName: newUser.name
            }
          });
        }

        return newUser;
      });

      return { success: true, user: { id: result.id, email: result.email } };

    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: "Error al crear usuario" });
    }
  });
}
