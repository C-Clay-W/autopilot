/**
 * Job 声明服务地址与监听归属核验的单测（Talk-Plan0908 R1）：
 * 只接受 loopback http(s) origin；回环别名等价；解析器对伪造/畸形输入 fail-closed。
 */

import { describe, expect, it } from "vitest";
import { jobServicePort, normalizeJobServiceUrl, sameServiceOrigin } from "../domain/job-service-url";
import { createDefaultJobServiceOwnershipProbe, type JobServiceOwnershipProbe } from "./job-service-ownership";

describe("normalizeJobServiceUrl", function suite() {
  it("接受 loopback http(s) origin 并固定端口", function acceptsLoopbackOrigins() {
    expect(normalizeJobServiceUrl("http://127.0.0.1:5199")).toBe("http://127.0.0.1:5199");
    expect(normalizeJobServiceUrl("http://127.0.0.1:5199/")).toBe("http://127.0.0.1:5199");
    expect(normalizeJobServiceUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeJobServiceUrl("http://[::1]:5199")).toBe("http://[::1]:5199");
    expect(normalizeJobServiceUrl("https://localhost")).toBe("https://localhost:443");
  });

  it("拒绝非 loopback、非根路径、凭据与畸形输入", function rejectsUnsafeInputs() {
    expect(normalizeJobServiceUrl("http://192.168.1.2:5199/")).toBeUndefined();
    expect(normalizeJobServiceUrl("http://127.0.0.1:5199/app")).toBeUndefined();
    expect(normalizeJobServiceUrl("http://127.0.0.1:5199/?x=1")).toBeUndefined();
    expect(normalizeJobServiceUrl("http://user@127.0.0.1:5199/")).toBeUndefined();
    expect(normalizeJobServiceUrl("ftp://127.0.0.1:5199/")).toBeUndefined();
    expect(normalizeJobServiceUrl("not a url")).toBeUndefined();
    expect(normalizeJobServiceUrl("")).toBeUndefined();
  });

  it("回环别名同端口视为同一 origin，不同端口不视为同一 origin", function comparesLoopbackAliases() {
    expect(sameServiceOrigin("http://localhost:5199/", "http://127.0.0.1:5199")).toBe(true);
    expect(sameServiceOrigin("http://[::1]:5199/", "http://127.0.0.1:5199/")).toBe(true);
    expect(sameServiceOrigin("http://127.0.0.1:51999/", "http://127.0.0.1:5199/")).toBe(false);
    expect(sameServiceOrigin("https://127.0.0.1:5199/", "http://127.0.0.1:5199/")).toBe(false);
    expect(sameServiceOrigin("http://127.0.0.1:5199/", "not a url")).toBe(false);
    expect(jobServicePort("http://127.0.0.1:5199/")).toBe(5199);
  });
});

describe("default ownership probe", function suite() {
  it("端口或 PID 越界时无法核验，不退化为按端口放行", async function rejectsOutOfRangeInputs() {
    const probe: JobServiceOwnershipProbe = createDefaultJobServiceOwnershipProbe();
    await expect(probe.listenerPids(0)).resolves.toBeUndefined();
    await expect(probe.listenerPids(70_000)).resolves.toBeUndefined();
    await expect(probe.ancestry(0)).resolves.toBeUndefined();
  });
});
