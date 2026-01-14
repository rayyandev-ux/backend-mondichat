import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function codesRoutes(server: FastifyInstance) {
    server.post('/admin/codes', {
        preValidation: [server.authenticate]
    }, async (request: any, reply) => {
        if (request.user.role !== 'admin') {
            return reply.status(403).send({ error: "No autorizado" });
        }

        try {
            // Generate a random 6-character alphanumeric code
            const codeString = Math.random().toString(36).substring(2, 8).toUpperCase();

            const newCode = await prisma.registrationCode.create({
                data: {
                    code: codeString,
                }
            });

            return { success: true, code: newCode };
        } catch (error) {
            request.log.error(error);
            return reply.status(500).send({ error: "Error creando código" });
        }
    });

    server.get('/admin/codes', {
        preValidation: [server.authenticate]
    }, async (request: any, reply) => {
        if (request.user.role !== 'admin') {
            return reply.status(403).send({ error: "No autorizado" });
        }

        try {
            const codes = await prisma.registrationCode.findMany({
                orderBy: { createdAt: 'desc' }
            });
            return codes;
        } catch (error) {
            request.log.error(error);
            return reply.status(500).send({ error: "Error obteniendo códigos" });
        }
    });
}
