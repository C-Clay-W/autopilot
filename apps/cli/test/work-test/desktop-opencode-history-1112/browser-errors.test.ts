// CLI错误边界仅用loopback替身响应，不创建Runtime、Provider或真实Desktop。
import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { main } from '../../../src/main.js';
import { browserRequest, getBrowserErrorCode } from '../../../src/browser-client.js';
afterEach(function cleanup() { vi.unstubAllEnvs(); });
/** 一次性HTTP服务只返回受控fixture，退出时立即关闭。 */
async function withResponse(body: string, run: (address: string) => Promise<void>) {
  const server = createServer(function response(_request, response) { response.end(body); });
  await new Promise<void>(function listen(resolve) { server.listen(0, '127.0.0.1', resolve); });
  const address = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  try { await run(address); } finally { await new Promise<void>(function close(resolve, reject) { server.close(function closed(error) { if (error) reject(error); else resolve(); }); }); }
}
/** 捕获CLI固定输出，不触发真实PTY。 */
function streams() {
  const stdout = { value: '', write: function write(value: string) { stdout.value += value; } };
  const stderr = { value: '', write: function write(value: string) { stderr.value += value; } };
  return { stdout, stderr };
}
it('browser CLI preserves exact fixed failure and masks spoofed prefix/secret details', async function fixedErrors() {
  for (const [error, expected] of [ ['BROWSER_PERMIT_INVALID', 'BROWSER_PERMIT_INVALID'], ['BROWSER_CALL_REPLAY', 'BROWSER_CALL_REPLAY'], ['BROWSER_CANCELLED', 'BROWSER_CANCELLED'], ['BROWSER_PERMIT_INVALID token=secret C:/private/file', 'BROWSER_REQUEST_FAILED'], ['BROWSER_UNKNOWN_SECRET', 'BROWSER_REQUEST_FAILED'], ['有其他智能体正在操控，请等待后再试', 'BROWSER_BUSY'] ]) {
    await withResponse(JSON.stringify({ ok: false, error }), async function check(address) {
      vi.stubEnv('AUTOPILOT_BROWSER_ENDPOINT', address); vi.stubEnv('AUTOPILOT_BROWSER_CALLER_TOKEN', 'fixture-token');
      const output = streams();
      expect(await main(['browser', 'list', '{}', '--permit', 'a'.repeat(64)], output)).toBe(1);
      expect(output.stderr.value).toBe(expected + '\n'); expect(output.stdout.value).toBe('');
      expect(output.stderr.value).not.toMatch(/secret|private|fixture-token/);
    });
  }
});
it('browser response malformed JSON is fixed; ordinary CLI errors remain masked', async function malformed() {
  await withResponse('{secret invalid JSON', async function check(address) { await expect(browserRequest(address, 'fixture', '/call', {})).rejects.toThrow(/^BROWSER_RESPONSE_INVALID$/); });
  const hostile = new Proxy({}, { getPrototypeOf: function trap() { throw new Error('secret'); } });
  expect(getBrowserErrorCode(hostile)).toBeUndefined();
  expect(getBrowserErrorCode(new Error('BROWSER_UNKNOWN_SECRET'))).toBeUndefined();
  const output = streams();
  expect(await main(['session', 'list'], output, { createCompositionRoot: function fail() { throw new Error('secret C:/private/file'); } })).toBe(1);
  expect(output.stderr.value).toBe('CLI_RUNTIME_ERROR\n');
});
it('browser missing native binding and cancellation retain distinct fixed errors', async function binding() {
  vi.stubEnv('AUTOPILOT_BROWSER_CALLER_TOKEN', '');
  const output = streams();
  expect(await main(['browser', 'list', '{}'], output)).toBe(1);
  expect(output.stderr.value).toBe('BROWSER_NATIVE_TOOL_BINDING_REQUIRED\n');
  await withResponse('{}', async function check(address) { const abort = new AbortController(); abort.abort(); await expect(browserRequest(address, 'fixture', '/call', {}, abort.signal)).rejects.toThrow(/^BROWSER_CANCELLED$/); });
});
