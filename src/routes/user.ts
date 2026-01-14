import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function userRoutes(server: FastifyInstance) {
  // Endpoint to generate a verification code for the logged-in user
  server.post('/user/generate-code', {
    preValidation: [server.authenticate]
  }, async (request: any, reply) => {
    try {
      const userEmail = request.user.email; // Extracted from JWT
      const code = `#Mondi-${Math.floor(1000 + Math.random() * 9000)}`;

      // Update user with the new code
      await prisma.user.update({
        where: { email: userEmail },
        data: { verificationCode: code }
      });

      return { success: true, code };
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: "Error generating code" });
    }
  });
}
