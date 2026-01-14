import type { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export async function routesRoutes(server: FastifyInstance) {
    server.get('/routes', async (request, reply) => {
        try {
            const routes = await prisma.routeData.findMany({
                distinct: ['routeCode'],
                select: {
                    routeCode: true
                },
                orderBy: {
                    routeCode: 'asc'
                }
            });

            return routes.map(r => r.routeCode);
        } catch (error) {
            request.log.error(error);
            return reply.status(500).send({ error: "Error fetching routes" });
        }
    });
}
