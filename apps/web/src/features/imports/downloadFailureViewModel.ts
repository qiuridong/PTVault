import {
  DownloadFailureDiagnosticSchema,
  type DownloadFailureDiagnostic,
} from '@ptvault/contracts';
import { formatDecimalBytes } from './importFormatting.js';

const LABELS: Record<DownloadFailureDiagnostic['kind'], string> = {
  DNS_FAILED: '下载地址解析失败',
  CONNECT_TIMEOUT: '下载连接建立超时',
  HEADERS_TIMEOUT: '等待下载响应头超时',
  BODY_TIMEOUT: '下载数据流停顿超时',
  CONNECTION_RESET: '下载连接被重置',
  CONNECTION_REFUSED: '下载连接被拒绝',
  NETWORK_UNREACHABLE: '下载网络不可达',
  SOCKET_FAILED: '下载套接字异常',
  TLS_FAILED: '下载 TLS 握手或证书校验失败',
  REQUEST_FAILED: '下载请求失败，底层原因未报告',
  BODY_READ_FAILED: '下载数据流读取失败，底层原因未报告',
  BODY_MISSING: '下载响应没有数据流',
  BODY_EMPTY_CHUNK: '下载返回空数据块',
  BODY_INCOMPLETE: '下载响应提前结束',
  HTTP_SERVER_ERROR: '下载服务暂时异常',
  HTTP_RATE_LIMITED: '下载服务限流',
  LEASE_REJECTED: '下载链接被拒绝',
  HTTP_UNEXPECTED_STATUS: '下载服务返回异常状态',
};
const LEGACY_LABELS: Readonly<Record<string, string>> = {
  NETWORK_CONNECT_TIMEOUT: '下载连接超时',
  NETWORK_DNS_FAILED: '下载地址解析暂时失败',
  NETWORK_HEADERS_TIMEOUT: '等待下载响应超时',
  NETWORK_BODY_TIMEOUT: '下载连接长时间没有数据',
  NETWORK_RESET: '网络或下载响应异常',
  DLINK_EXPIRED: '下载链接需要刷新',
  SOURCE_RESPONSE_INVALID: '网盘下载响应暂时异常',
};
const PHASE = {
  REQUEST: '请求 / 建立连接',
  RESPONSE_HEADERS: '响应头',
  RESPONSE_BODY: '接收数据流',
};

export function downloadFailureViewModel(
  code: string | null | undefined,
  diagnostic?: DownloadFailureDiagnostic,
) {
  const parsed = DownloadFailureDiagnosticSchema.safeParse(diagnostic);
  if (parsed.success) {
    const value = parsed.data;
    const label =
      LABELS[value.kind] + (value.httpStatus === undefined ? '' : `（HTTP ${value.httpStatus}）`);
    const evidence = [`环节：${PHASE[value.phase]}`];
    if (value.transportCode !== undefined) evidence.push(`底层代码：${value.transportCode}`);
    if (value.receivedBytes !== undefined && value.expectedBytes !== undefined)
      evidence.push(
        `本次连接接收 ${formatDecimalBytes(value.receivedBytes)} / 预期 ${formatDecimalBytes(value.expectedBytes)}（不等于持久化断点）`,
      );
    const hint =
      value.kind === 'HTTP_SERVER_ERROR'
        ? '已确认是服务端 5xx 响应，不能据此认定账户被限流。'
        : value.kind === 'HTTP_RATE_LIMITED'
          ? '下载服务明确返回 HTTP 429，继续遵循原有提供方退避时间。'
          : value.kind === 'LEASE_REJECTED'
            ? '将按原有策略刷新下载链接；这不等于账户授权失效。'
            : value.kind === 'REQUEST_FAILED' || value.kind === 'BODY_READ_FAILED'
              ? '只记录了失败环节，没有足以确定更底层原因的证据。'
              : '此处是最近一次失败的记录，不表示当前仍在发生相同故障。';
    return { label, hint, evidence };
  }
  if (code === undefined || code === null || !Object.hasOwn(LEGACY_LABELS, code)) return undefined;
  return {
    label: LEGACY_LABELS[code]!,
    hint:
      code === 'NETWORK_RESET'
        ? '此记录未保留细分诊断，无法区分连接异常、响应提前结束或 HTTP 5xx，也不能据此认定限流。'
        : '此记录仅保留了错误分类，没有更细的底层诊断。',
    evidence: [] as string[],
  };
}
