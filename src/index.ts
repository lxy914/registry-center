// src/index.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { timing } from 'hono/timing';
import { secureHeaders } from 'hono/secure-headers';

// 服务节点信息（单节点）
interface ServiceNode {
  address: string;
  lastHeartbeat: number;
}

// 服务注册请求体（仅需serviceName+address）
interface RegisterRequest {
  serviceName: string;
  address: string;
}

// 环境变量类型
interface Env {
  register_center: KVNamespace;
  API_KEY: string;
}

// 常量定义
const HEARTBEAT_EXPIRE = 300; // 300秒过期
const KV_DEFAULT_TTL = 3600 * 24; // KV兜底TTL（符合平台限制）
const app = new Hono<{ Bindings: Env }>();

// 全局中间件
app.use('*', timing());
app.use('*', secureHeaders());
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST'],
    allowHeaders: ['Content-Type', 'X-API-Key'],
  })
);

// 访问控制中间件（极简API Key验证）
app.use('*', async (c, next) => {
  if (c.req.path === '/health') {
    await next();
    return;
  }
  const requestApiKey = c.req.header('X-API-Key');
  if (!requestApiKey || requestApiKey !== c.env.API_KEY) {
    return c.json({ code: 401, message: '未授权:请携带有效的X-API-Key' }, 401);
  }
  await next();
});

// 工具函数：检查节点是否过期
const isNodeExpired = (node: ServiceNode): boolean => {
  return Date.now() - node.lastHeartbeat > HEARTBEAT_EXPIRE*1000;
};

// 工具函数：清理单个服务的过期节点（仅操作内存，1次get+1次put）
const cleanExpiredNodes = async (env: Env, serviceName: string): Promise<ServiceNode[]> => {
  // 1. 仅1次get（核心优化：替代list遍历）
  const serviceStr = await env.register_center.get(serviceName);
  if (!serviceStr) return [];

  // 2. 内存中过滤过期节点
  const nodes = JSON.parse(serviceStr) as ServiceNode[];
  const activeNodes = nodes.filter(node => !isNodeExpired(node));

  // 3. 有活跃节点则更新，无则删除（避免空数据）
  if (activeNodes.length > 0) {
    await env.register_center.put(
      serviceName,
      JSON.stringify(activeNodes),
      { expirationTtl: KV_DEFAULT_TTL }
    );
  } else {
    await env.register_center.delete(serviceName);
  }
  return activeNodes;
};

// 工具函数：清理所有服务的过期节点（仅健康检查时调用，低频）
const cleanAllExpiredNodes = async (env: Env) => {
  // 仅此处用list()，但健康检查调用频率低（比如每分钟1次），几乎不消耗次数
  const list = await env.register_center.list({ prefix: '' });
  for await (const key of list.keys) {
    await cleanExpiredNodes(env, key.name);
  }
};

// 1. 注册服务 (POST /register) —— 仅1次get+1次put
app.post('/register', async (c) => {
  try {
    const body = await c.req.json<RegisterRequest>();
    if (!body.serviceName || !body.address) {
      return c.json({ code: 400, message: '缺少serviceName/address' }, 400);
    }

    // 1. 获取该服务现有节点（1次get）
    const serviceStr = await c.env.register_center.get(body.serviceName);
    const nodes: ServiceNode[] = serviceStr ? JSON.parse(serviceStr) : [];

    // 2. 去重：避免重复注册
    const isDuplicate = nodes.some(node => node.address === body.address);
    if (isDuplicate) {
      return c.json({ code: 200, message: '服务已注册'}, 200);
    }

    // 3. 添加新节点（初始化心跳）
    nodes.push({
      address: body.address,
      lastHeartbeat: Date.now(),
    });

    // 4. 存储（1次put）
    await c.env.register_center.put(
      body.serviceName,
      JSON.stringify(nodes),
      { expirationTtl: KV_DEFAULT_TTL }
    );

    return c.json({
      code: 200,
      message: '服务注册成功',
    });
  } catch (error) {
    console.error('注册失败:', error);
    return c.json({ code: 500, message: '注册失败', error: (error as Error).message }, 500);
  }
});

// 2. 心跳更新 (PUT /heartbeat) —— 仅1次get+1次put
app.post('/heartbeat', async (c) => {
  try {
    const body = await c.req.json<RegisterRequest>();
    if (!body.serviceName || !body.address) {
      return c.json({ code: 400, message: '缺少serviceName/address' }, 400);
    }

    // 1. 获取该服务节点（1次get）
    const serviceStr = await c.env.register_center.get(body.serviceName);
    if (!serviceStr) {
      return c.json({ code: 404, message: '服务未注册' }, 404);
    }

    // 2. 更新对应节点的心跳
    const nodes = JSON.parse(serviceStr) as ServiceNode[];
    const nodeIndex = nodes.findIndex(node => node.address === body.address);
    if (nodeIndex === -1) {
      return c.json({ code: 404, message: '节点未注册' }, 404);
    }
    nodes[nodeIndex].lastHeartbeat = Date.now();

    // 3. 存储（1次put）
    await c.env.register_center.put(
      body.serviceName,
      JSON.stringify(nodes),
      { expirationTtl: KV_DEFAULT_TTL }
    );

    return c.json({
      code: 200,
      message: '心跳更新成功',
      data: {
        serviceName: body.serviceName,
        address: body.address,
        lastHeartbeat: nodes[nodeIndex].lastHeartbeat,
        nextDeadline: nodes[nodeIndex].lastHeartbeat + HEARTBEAT_EXPIRE*1000,
      },
    });
  } catch (error) {
    console.error('心跳更新失败:', error);
    return c.json({ code: 500, message: '心跳失败', error: (error as Error).message }, 500);
  }
});

// 3. 服务发现 (GET /discover) —— 仅1次get（核心优化）
app.get('/discover', async (c) => {
  try {
    const serviceName = c.req.query('serviceName');
    if (!serviceName) {
      return c.json({ code: 400, message: '缺少serviceName参数' }, 400);
    }

    // 1. 清理过期节点 + 获取活跃节点（仅1次get）
    const activeNodes = await cleanExpiredNodes(c.env, serviceName);

    return c.json({
      code: 200,
      message: '服务发现成功',
      data: {
        serviceName,
        activeCount: activeNodes.length,
        activeAddresses: activeNodes.map(node => node.address),
        nodes: activeNodes,
      },
    });
  } catch (error) {
    console.error('发现失败:', error);
    return c.json({ code: 500, message: '发现失败', error: (error as Error).message }, 500);
  }
});

// 4. 注销服务 (DELETE /unregister) —— 仅1次get+1次put
app.post('/unregister', async (c) => {
  try {
    const body = await c.req.json<RegisterRequest>();
    if (!body.serviceName || !body.address) {
      return c.json({ code: 400, message: '缺少serviceName/address' }, 400);
    }

    // 1. 获取该服务节点（1次get）
    const serviceStr = await c.env.register_center.get(body.serviceName);
    if (!serviceStr) {
      return c.json({ code: 404, message: '服务未注册' }, 404);
    }

    // 2. 过滤掉要注销的节点
    const nodes = JSON.parse(serviceStr) as ServiceNode[];
    const newNodes = nodes.filter(node => node.address !== body.address);
    if (newNodes.length === nodes.length) {
      return c.json({ code: 404, message: '节点未注册' }, 404);
    }

    // 3. 更新存储（1次put/delete）
    if (newNodes.length > 0) {
      await c.env.register_center.put(body.serviceName, JSON.stringify(newNodes));
    } else {
      await c.env.register_center.delete(body.serviceName);
    }

    return c.json({
      code: 200,
      message: '服务注销成功'
    });
  } catch (error) {
    console.error('注销失败:', error);
    return c.json({ code: 500, message: '注销失败', error: (error as Error).message }, 500);
  }
});

// 健康检查（低频调用list()，几乎不消耗次数）
app.get('/health', async (c) => {
  await cleanAllExpiredNodes(c.env);
  return c.json({
    code: 200,
    message: '注册中心运行正常',
    timestamp: Date.now(),
    heartbeatExpireMs: HEARTBEAT_EXPIRE,
    kvTtl: KV_DEFAULT_TTL
  });
});

export default app;