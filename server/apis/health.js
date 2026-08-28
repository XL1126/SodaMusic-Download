/**
 * 健康检查接口（GET /api/health）
 *  - 由前端启动前或调试器探测后端是否存活。
 *  - 返回纯 JSON：服务状态 + 进程监听端口（默认 3001，可通过 PORT env 覆盖）。
 */

const request = {
  method: 'get',
  path: '/api/health',
  query: {},
  headers: {},
  body: null,
}

const response = {
  message: 'PopDownloader local API is running',
  author: 'jason',
  port: 3001,
}

module.exports = {
  name: 'health',
  method: request.method,
  path: request.path,
  request,
  response,
  handler: (_req, res) => {
    res.json({
      message: response.message,
      author: response.author,
      port: process.env.PORT || response.port,
    })
  },
}
