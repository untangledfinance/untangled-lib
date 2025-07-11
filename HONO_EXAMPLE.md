# Hono.js Server Example

This example demonstrates using the Hono.js embedded server in the untangled-web framework.

## Setup

1. Set the environment variable to use Hono server:
```bash
export EMBEDDED_SERVER=hono
```

2. Create a simple application (example-hono-app.js):

```javascript
// Import the framework components
import { Application, Module } from 'untangled-web/core/http';

// Define a simple controller
class HealthController {
  async getHealth(req, res) {
    return {
      status: 200,
      data: { 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        server: 'hono',
        path: req.path 
      }
    };
  }
}

// Define the application module
@Module({
  controllers: [HealthController],
})
class App extends Application {
  constructor() {
    super();
    
    // Add routes
    this.get('/health', (req, res) => new HealthController().getHealth(req, res));
    this.get('/', (req, res) => ({
      status: 200,
      data: { message: 'Hello from Hono.js embedded server!' }
    }));
    
    // Enable CORS
    this.cors('*');
  }
}

// Start the application
async function start() {
  const app = new App();
  
  app.on('started', (info) => {
    console.log(`🚀 Hono server started on http://${info.app.host || '0.0.0.0'}:${info.app.port}`);
    console.log(`📦 Server type: ${info.app.type}`);
    console.log(`🌍 Environment: ${info.app.env || 'development'}`);
  });
  
  await app.start({
    port: 8080,
    host: '0.0.0.0'
  });
}

start().catch(console.error);
```

3. Run the application:
```bash
EMBEDDED_SERVER=hono node example-hono-app.js
```

## Features Supported

The Hono.js implementation supports all the same features as Express and Fastify:

- ✅ HTTP routing (GET, POST, PUT, DELETE, PATCH, etc.)
- ✅ Middleware support
- ✅ CORS configuration
- ✅ Error handling
- ✅ Request/Response abstraction
- ✅ Route groups and prefixes
- ✅ Event emission (start, started, stop, stopped, request, response)
- ✅ Body parsing (JSON, form data)
- ✅ TypeScript support

## Server Selection

You can choose between different embedded servers by setting the `EMBEDDED_SERVER` environment variable:

- `EMBEDDED_SERVER=express` (default)
- `EMBEDDED_SERVER=fastify`
- `EMBEDDED_SERVER=hono` (new!)

## Performance

Hono.js is known for its excellent performance characteristics:
- Fast routing with minimal overhead
- Small bundle size
- Efficient request/response handling
- Modern JavaScript/TypeScript support