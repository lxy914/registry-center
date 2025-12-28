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

// 心跳/注册请求体（仅需serviceName+address）
interface HeartbeatRequest {
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
  return Date.now() - node.lastHeartbeat > HEARTBEAT_EXPIRE * 1000;
};

// 工具函数：清理单个服务的过期节点（仅操作内存，1次get+1次put）
const cleanExpiredNodes = async (env: Env, serviceName: string): Promise<ServiceNode[]> => {
  const serviceStr = await env.register_center.get(serviceName);
  if (!serviceStr) return [];

  const nodes = JSON.parse(serviceStr) as ServiceNode[];
  const activeNodes = nodes.filter(node => !isNodeExpired(node));

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
  const list = await env.register_center.list({ prefix: '' });
  for await (const key of list.keys) {
    await cleanExpiredNodes(env, key.name);
  }
};

// 核心接口：心跳/注册二合一 (POST /heartbeat)
// 首次调用 = 注册，后续调用 = 心跳更新，过期后调用 = 重新激活
app.post('/heartbeat', async (c) => {
  try {
    const body = await c.req.json<HeartbeatRequest>();
    if (!body.serviceName || !body.address) {
      return c.json({ code: 400, message: '缺少serviceName/address' }, 400);
    }

    // 1. 获取该服务现有节点
    const serviceStr = await c.env.register_center.get(body.serviceName);
    let nodes: ServiceNode[] = serviceStr ? JSON.parse(serviceStr) : [];
    const nodeIndex = nodes.findIndex(node => node.address === body.address);
    const now = Date.now();

    // 2. 分场景处理
    let operationType: string;
    if (nodeIndex === -1) {
      // 场景1：节点不存在（首次注册/过期被删）→ 新增节点
      nodes.push({
        address: body.address,
        lastHeartbeat: now,
      });
      operationType = 'register'; // 首次注册/重新激活
    } else {
      // 场景2：节点存在 → 更新心跳
      nodes[nodeIndex].lastHeartbeat = now;
      operationType = 'heartbeat'; // 心跳更新
    }

    // 3. 存储更新后的节点列表
    await c.env.register_center.put(
      body.serviceName,
      JSON.stringify(nodes),
      { expirationTtl: KV_DEFAULT_TTL }
    );

    // 4. 返回不同场景的提示
    const messages:{ [key: string]: string } = {
      register: '节点首次注册成功（或已过期重新激活）',
      heartbeat: '心跳更新成功'
    };
    return c.json({
      code: 200,
      message: messages[operationType],
      data: {
        serviceName: body.serviceName,
        address: body.address,
        lastHeartbeat: now,
        nextDeadline: now + HEARTBEAT_EXPIRE * 1000,
        operationType // 标识本次操作类型
      },
    });
  } catch (error) {
    console.error('心跳/注册失败:', error);
    return c.json({ code: 500, message: '操作失败', error: (error as Error).message }, 500);
  }
});

// 服务发现 (GET /discover)
app.get('/discover', async (c) => {
  try {
    const serviceName = c.req.query('serviceName');
    if (!serviceName) {
      return c.json({ code: 400, message: '缺少serviceName参数' }, 400);
    }

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

// 注销服务 (POST /unregister)
app.post('/unregister', async (c) => {
  try {
    const body = await c.req.json<HeartbeatRequest>();
    if (!body.serviceName || !body.address) {
      return c.json({ code: 400, message: '缺少serviceName/address' }, 400);
    }

    const serviceStr = await c.env.register_center.get(body.serviceName);
    if (!serviceStr) {
      return c.json({ code: 404, message: '服务未注册' }, 404);
    }

    const nodes = JSON.parse(serviceStr) as ServiceNode[];
    const newNodes = nodes.filter(node => node.address !== body.address);
    if (newNodes.length === nodes.length) {
      return c.json({ code: 404, message: '节点未注册' }, 404);
    }

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

// 健康检查
app.get('/health', async (c) => {
  await cleanAllExpiredNodes(c.env);
  return c.json({
    code: 200,
    message: '注册中心运行正常',
    timestamp: Date.now(),
    heartbeatExpire: HEARTBEAT_EXPIRE,
    kvTtl: KV_DEFAULT_TTL
  });
});

export default app;