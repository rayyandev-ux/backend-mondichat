import Fastify, { type FastifyInstance } from 'fastify'
import jwt from '@fastify/jwt'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import { PrismaClient } from '@prisma/client'
import dotenv from 'dotenv'
import { adminRoutes } from './routes/admin.js'
import { webhookRoutes } from './routes/webhook.js'
import { userRoutes } from './routes/user.js'
import { authRoutes } from './routes/auth.js'
import { codesRoutes } from './routes/codes.js'
import { routesRoutes } from './routes/routes.js'
import { checkWazendConnection } from './services/wazend.js'

dotenv.config()

const prisma = new PrismaClient()
const server: FastifyInstance = Fastify({ logger: true })

// Security
server.register(helmet)
server.register(cors)
server.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute'
})

// File Upload
server.register(multipart)

// Auth
console.log("AUTH_SECRET loaded:", process.env.AUTH_SECRET ? "YES" : "NO", process.env.AUTH_SECRET?.substring(0, 3) + "...");

server.register(jwt, {
  secret: process.env.AUTH_SECRET || 'supersecret'
})

server.decorate('authenticate', async (request: any, reply: any) => {
  try {
    await request.jwtVerify()
  } catch (err) {
    reply.send(err)
  }
})

// Routes
server.register(adminRoutes)
server.register(webhookRoutes)
server.register(userRoutes)
server.register(authRoutes)
server.register(codesRoutes)
server.register(routesRoutes)

server.get('/ping', async (request, reply) => {
  return { pong: 'it works!' }
})

server.get('/users', async (request, reply) => {
    const users = await prisma.user.findMany()
    return users
})

const start = async () => {
  try {
    await server.listen({ port: 3001, host: '0.0.0.0' })
    
    // Check WAZEND Connection
    checkWazendConnection();
    
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

start()
