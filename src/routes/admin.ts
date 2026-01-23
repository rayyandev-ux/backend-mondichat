import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { processCsvUpload } from '../services/csvParser.js';

const prisma = new PrismaClient();

export async function adminRoutes(server: FastifyInstance) {
  server.post('/admin/upload-csv', {
    schema: {
        // Optional: Swagger/OpenAPI schema
        response: {
            200: {
                type: 'object',
                properties: {
                    success: { type: 'boolean' },
                    count: { type: 'number' },
                    batchId: { type: 'string' }
                }
            },
            400: {
                type: 'object',
                properties: {
                    error: { type: 'string' }
                }
            },
            500: {
                type: 'object',
                properties: {
                    error: { type: 'string' }
                }
            }
        }
    },
    // PreValidation hook to check for admin role
    preValidation: [server.authenticate] 
  }, async (request, reply) => {
    const data = await request.file();
    
    if (!data) {
      return reply.status(400).send({ error: "No se subió ningún archivo" });
    }

    try {
      const buffer = await data.toBuffer();
      const result = await processCsvUpload(buffer);
      return result;
    } catch (error: any) {
      request.log.error(error);
      return reply.status(500).send({ error: error.message });
    }
  });

  server.get('/admin/users', {
    preValidation: [server.authenticate]
  }, async (request: any, reply) => {
    if (request.user.role !== 'admin') {
        return reply.status(403).send({ error: "No autorizado" });
    }
    try {
        const users = await prisma.user.findMany({
            orderBy: { createdAt: 'desc' }
        });
        return users;
    } catch (error) {
        request.log.error(error);
        return reply.status(500).send({ error: "Error fetching users" });
    }
  });

  server.delete('/admin/users/:id', {
    schema: {
        response: {
            200: {
                type: 'object',
                properties: {
                    success: { type: 'boolean' }
                }
            },
            403: {
                type: 'object',
                properties: {
                    error: { type: 'string' }
                }
            },
            500: {
                type: 'object',
                properties: {
                    error: { type: 'string' }
                }
            }
        }
    },
    preValidation: [server.authenticate]
  }, async (request: any, reply) => {
    // Check if requester is admin
    const requesterRole = request.user.role;
    if (requesterRole !== 'admin') {
        return reply.status(403).send({ error: "No autorizado" });
    }

    const { id } = request.params;
    
    try {
        await prisma.user.delete({ where: { id } });
        return { success: true };
    } catch (error) {
        request.log.error(error);
        return reply.status(500).send({ error: "Error al eliminar usuario" });
    }
  });

  server.post('/admin/users/:id/unlink', {
    preValidation: [server.authenticate]
  }, async (request: any, reply) => {
    // Check if requester is admin
    const requesterRole = request.user.role;
    if (requesterRole !== 'admin') {
        return reply.status(403).send({ error: "No autorizado" });
    }

    try {
        const { id } = request.params as { id: string };
        await prisma.user.update({
            where: { id },
            data: {
                whatsappId: null,
                verificationCode: null
            }
        });
        return { success: true };
    } catch (error) {
        request.log.error(error);
        return reply.status(500).send({ error: "Error unlinking user" });
    }
  });

  server.patch('/admin/users/:id/route', {
    preValidation: [server.authenticate]
  }, async (request: any, reply) => {
    const requesterRole = request.user.role;
    if (requesterRole !== 'admin') {
        return reply.status(403).send({ error: "No autorizado" });
    }

    const { id } = request.params as { id: string };
    const { route } = request.body as { route?: string };

    if (!route || typeof route !== 'string') {
        return reply.status(400).send({ error: "Ruta requerida" });
    }

    try {
        const updated = await prisma.user.update({
            where: { id },
            data: { route }
        });
        return { success: true, user: updated };
    } catch (error) {
        request.log.error(error);
        return reply.status(500).send({ error: "Error actualizando ruta" });
    }
  });
}
