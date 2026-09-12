import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import type {
  PipelineMetric,
  PipelineObservationPoint,
  PipelineObservationResponse,
} from '@ptvault/contracts';
import { getGroupObservations, groupErrorMessage, observationQuery } from './groupApi.js';
import { formatDecimalBytes } from './importFormatting.js';

type Unit = '%' | 'B' | 'B/s' | '核' | '组' | '项' | '秒';
const METRICS: Record<PipelineMetric, { label: string; unit: Unit }> = {
  hostCpuPercent: { label: '主机 CPU 忙碌（含 steal）', unit: '%' },
  hostStealPercent: { label: '主机 CPU steal', unit: '%' },
  hostMemoryUsedPercent: { label: '主机内存使用', unit: '%' },
  hostSwapUsedBytes: { label: '主机 Swap 使用', unit: 'B' },
  hostReadBps: { label: '主机磁盘读', unit: 'B/s' },
  hostWriteBps: { label: '主机磁盘写', unit: 'B/s' },
  hostRxBps: { label: '主机默认网口接收', unit: 'B/s' },
  hostTxBps: { label: '主机默认网口发送', unit: 'B/s' },
  hostCpuPressureSome: { label: '主机 CPU PSI some（avg10）', unit: '%' },
  hostMemoryPressureSome: { label: '主机内存 PSI some（avg10）', unit: '%' },
  hostMemoryPressureFull: { label: '主机内存 PSI full（avg10）', unit: '%' },
  hostIoPressureSome: { label: '主机 IO PSI some（avg10）', unit: '%' },
  hostIoPressureFull: { label: '主机 IO PSI full（avg10）', unit: '%' },
  cgroupCpuCores: { label: 'API cgroup CPU 核数', unit: '核' },
  cgroupMemoryBytes: { label: 'API cgroup 内存', unit: 'B' },
  cgroupSwapBytes: { label: 'API cgroup Swap', unit: 'B' },
  cgroupReadBps: { label: 'API cgroup 磁盘读', unit: 'B/s' },
  cgroupWriteBps: { label: 'API cgroup 磁盘写', unit: 'B/s' },
  downloadActive: { label: '活跃下载组数', unit: '组' },
  extractionActive: { label: '活跃解压组数', unit: '组' },
  uploadActive: { label: '活跃上传及双回读组数', unit: '组' },
  residentBytes: { label: '分组暂存数据', unit: 'B' },
  reservedBytes: { label: '全部迁移预留空间', unit: 'B' },
  qbDownloading: { label: 'qB 库存中的下载任务', unit: '项' },
  qbSeeding: { label: 'qB 库存中的做种任务', unit: '项' },
  qbInventoryAgeSeconds: { label: 'qB 最旧库存采样年龄', unit: '秒' },
  jellyfinPlaying: { label: 'Jellyfin 未暂停播放会话', unit: '项' },
  jellyfinTranscoding: { label: 'Jellyfin 转码播放会话', unit: '项' },
  jellyfinSampleAgeSeconds: { label: 'Jellyfin 活动采样年龄', unit: '秒' },
};
function valueText(value: number | null | undefined, unit: Unit): string {
  if (value == null) return '未采样 / 不可用';
  if (unit === 'B' || unit === 'B/s')
    return formatDecimalBytes(Math.round(value).toString()) + (unit === 'B/s' ? '/s' : '');
  return `${value.toFixed(unit === '组' ? 1 : 2)} ${unit}`;
}
export function GroupObservationsPanel() {
  const [hours, setHours] = useState(24),
    [to, setTo] = useState(Date.now),
    [metric, setMetric] = useState<PipelineMetric>('hostCpuPercent'),
    [eventPage, setEventPage] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTo(Date.now()), 60000);
    return () => window.clearInterval(timer);
  }, []);
  const from = to - hours * 3600000;
  const query = useQuery({
    queryKey: ['group-observations', hours, to],
    queryFn: () => getGroupObservations(from, to),
  });
  const data = query.data;
  return (
    <div className="group-observations">
      <section className="settings-card">
        <h3>分组流水线 · 多日观测</h3>
        <p className="field-hint">
          复用服务器每 10 秒的主机采样，保留 7 天原始点和 30 天分钟汇总；观测库默认上限 256
          MiB。这里展示已经收到的数据，不把尚未采集的几天当作验收结果。
        </p>
        <div className="baidu-browser-actions">
          <label className="inventory-filter">
            <span>观测时间窗口</span>
            <select
              aria-label="观测时间窗口"
              value={hours}
              onChange={(event) => {
                setHours(Number(event.target.value));
                setTo(Date.now());
                setEventPage(0);
              }}
            >
              {[1, 6, 24, 72, 168, 720].map((value) => (
                <option key={value} value={value}>
                  {value < 24 ? `${value} 小时` : `${value / 24} 天`}
                </option>
              ))}
            </select>
          </label>
          <button
            className="ghost-button"
            type="button"
            disabled={query.isFetching}
            onClick={() => setTo(Date.now())}
          >
            刷新观测
          </button>
          <a
            className="ghost-button"
            href={`/api/import-pipelines/observations/export?${observationQuery(from, to)}`}
          >
            导出脱敏诊断 JSON
          </a>
        </div>
        {query.isPending ? <p role="status">正在读取观测历史…</p> : null}
        {query.isError ? <p role="alert">{groupErrorMessage(query.error)}</p> : null}
        {data ? (
          <>
            <dl className="import-plan-figures">
              <div>
                <dt>选定窗口已验证视频</dt>
                <dd>{formatDecimalBytes(data.summary.verifiedBytes)}</dd>
              </div>
              <div>
                <dt>窗口有效吞吐（含空闲时间）</dt>
                <dd>{data.summary.verifiedGiBPerHour.toFixed(3)} GiB/h</dd>
              </div>
              <div>
                <dt>完成 / 有失败事件的组</dt>
                <dd>
                  {data.summary.completedGroups} / {data.summary.failedGroups}
                </dd>
              </div>
              <div>
                <dt>采样覆盖率</dt>
                <dd>
                  {(data.coverage * 100).toFixed(1)}% · {data.sampleCount} 次
                </dd>
              </div>
              <div>
                <dt>实际已有观测跨度</dt>
                <dd>{data.summary.observedHours.toFixed(2)} 小时</dd>
              </div>
              <div>
                <dt>观测存储</dt>
                <dd>
                  {formatDecimalBytes(String(data.status.storageBytes))} /{' '}
                  {formatDecimalBytes(String(data.status.maxBytes))}
                </dd>
              </div>
            </dl>
            <p className="field-hint">
              吞吐按首次 committed 解密回读通过的唯一输出计算，不把上传 socket
              速度或名额释放当作完成。失败组后来恢复后，仍保留本窗口的失败事件统计。
            </p>
            <p role="status" className="inline-message">
              {data.summary.sufficient
                ? '已有可比较样本；结合失败率、空间峰值和压力曲线，一次只调整一个参数。'
                : '样本不足，先保持当前配置：需要至少 6 小时有效跨度、80% 覆盖率及 3 个完成组，再比较不同配置。'}
              不自动提高并发。
            </p>
            {data.status.state !== 'HEALTHY' || data.status.dropped > 0 ? (
              <p role="alert">
                观测状态：{data.status.state} · 丢弃 {data.status.dropped} 条 · 待写{' '}
                {data.status.queued} 条。观测故障不停止迁移；空白时段不是零负载。
              </p>
            ) : null}
            <p className="field-hint">
              采集起止：
              {data.firstSampleAt === null
                ? '尚无样本'
                : new Date(data.firstSampleAt).toLocaleString()}{' '}
              →{' '}
              {data.lastSampleAt === null
                ? '尚无样本'
                : new Date(data.lastSampleAt).toLocaleString()}
              。{data.resolution === 'RAW' ? '原始采样' : '分钟汇总'}
              经分桶展示，曲线为均值，表内另列峰值。
            </p>
          </>
        ) : null}
      </section>
      {data ? (
        <>
          <section className="settings-card">
            <h3>负载与阶段趋势</h3>
            <p className="field-hint">
              主机数据包含其他程序；API 所在 cgroup（含子进程）不包含其他服务单元的只读挂载进程。qB
              活动复用最近库存（超过 10 分钟或同步失败即记为未知），Jellyfin
              每分钟只读采样会话；两者均记录采样年龄。活动数量不是 CPU / IO
              占用归因，请结合实际使用时段比较。
            </p>
            <div className="group-charts-grid">
              <MetricChart
                title="CPU 与调度等待"
                data={data}
                keys={['hostCpuPercent', 'hostStealPercent']}
              />
              <MetricChart
                title="内存压力"
                data={data}
                keys={['hostMemoryPressureSome', 'hostMemoryPressureFull']}
              />
              <MetricChart
                title="阶段交叠"
                data={data}
                keys={['downloadActive', 'extractionActive', 'uploadActive']}
              />
              <MetricChart
                title="暂存数据与预留"
                data={data}
                keys={['residentBytes', 'reservedBytes']}
              />
            </div>
            <label className="field">
              <span>检查单项指标</span>
              <select
                value={metric}
                onChange={(event) => setMetric(event.target.value as PipelineMetric)}
              >
                {(Object.keys(METRICS) as PipelineMetric[]).map((key) => (
                  <option key={key} value={key}>
                    {METRICS[key].label}
                  </option>
                ))}
              </select>
            </label>
            <MetricChart title={METRICS[metric].label} data={data} keys={[metric]} />
          </section>
          <section className="settings-card">
            <h3>窗口指标与配置标记</h3>
            <div
              className="group-bounded-list"
              role="region"
              aria-label="观测指标数值"
              tabIndex={0}
            >
              <table className="group-metric-table">
                <thead>
                  <tr>
                    <th>指标</th>
                    <th>末桶均值</th>
                    <th>窗口采样峰值</th>
                  </tr>
                </thead>
                <tbody>
                  {(Object.keys(METRICS) as PipelineMetric[]).map((key) => {
                    const peaks = data.points
                      .map((point) => point.maxima[key])
                      .filter((value): value is number => value != null);
                    return (
                      <tr key={key}>
                        <th scope="row">{METRICS[key].label}</th>
                        <td>{valueText(data.points.at(-1)?.metrics[key], METRICS[key].unit)}</td>
                        <td>
                          {valueText(peaks.length ? Math.max(...peaks) : null, METRICS[key].unit)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="field-hint">
              采样配置修订：
              {[
                ...new Set(
                  data.points.map((point) =>
                    point.configRevision === null ? '混合 / 未记录' : `r${point.configRevision}`,
                  ),
                ),
              ].join('、') || '尚无样本'}
              。构建：
              {[...new Set(data.points.map((point) => point.build ?? '混合 / 未记录'))].join(
                '、',
              ) || '尚无样本'}
              。
            </p>
          </section>
          <section className="settings-card">
            <h3>阶段与状态事件</h3>
            <p className="field-hint">
              仅导出内部标识、固定事件码、用量和时长，不含文件名、路径、下载链接、密码或令牌。RELEASED
              仅表示名额释放；成功以 IMPORT_COMPLETED /
              已验证回执为准。较早的业务事件未记录构建与配置时保持“未记录”。
            </p>
            <div
              key={eventPage}
              className="group-bounded-list"
              role="region"
              aria-label="观测事件"
              tabIndex={0}
            >
              <ul className="import-blockers">
                {data.events.slice(eventPage * 20, eventPage * 20 + 20).map((event) => (
                  <li key={event.id}>
                    <time>{new Date(event.at).toLocaleString()}</time> ·{' '}
                    <code>
                      {event.kind} / {event.code}
                      {event.failureCode ? ` / ${event.failureCode}` : ''}
                    </code>
                    <p>
                      组 {event.groupKey?.slice(0, 8) ?? '全局'} · 尝试 {event.attempt ?? '未记录'}{' '}
                      · 时长{' '}
                      {event.durationMs === null
                        ? '未记录'
                        : `${(event.durationMs / 1000).toFixed(2)} 秒`}{' '}
                      · 配置 {event.configRevision === null ? '未记录' : `r${event.configRevision}`}
                    </p>
                  </li>
                ))}
              </ul>
              {data.events.length === 0 ? <p>该窗口尚无分组事件。</p> : null}
            </div>
            <div className="baidu-browser-actions">
              <button
                type="button"
                className="ghost-button"
                disabled={eventPage === 0}
                onClick={() => setEventPage(eventPage - 1)}
              >
                较新事件
              </button>
              <span>
                显示 {Math.min(eventPage * 20 + 1, data.events.length)}–
                {Math.min((eventPage + 1) * 20, data.events.length)} / {data.events.length}
              </span>
              <button
                type="button"
                className="ghost-button"
                disabled={(eventPage + 1) * 20 >= data.events.length}
                onClick={() => setEventPage(eventPage + 1)}
              >
                较早事件
              </button>
            </div>
            {data.eventsTruncated ? (
              <p className="field-hint">
                窗口事件超过 1,000 条，仅显示最新 1,000
                条；缩小窗口查看更早事件，导出也保留这一截断标记。
              </p>
            ) : null}
          </section>
        </>
      ) : null}
    </div>
  );
}
function MetricChart({
  title,
  data,
  keys,
}: {
  title: string;
  data: PipelineObservationResponse;
  keys: readonly PipelineMetric[];
}) {
  const id = useId(),
    unit = METRICS[keys[0]!].unit;
  const all = data.points
    .flatMap((point) => keys.map((key) => point.metrics[key]))
    .filter((value): value is number => value != null);
  const maximum = unit === '%' ? 100 : Math.max(1, ...all),
    width = 500,
    height = 150;
  const x = (point: PipelineObservationPoint) =>
    40 + ((point.at - data.from) / Math.max(1, data.to - data.from)) * (width - 48);
  const y = (value: number) => height - 22 - (value / maximum) * (height - 36);
  const expectedGap = Math.max(60000, (data.to - data.from) / 240) * 2;
  return (
    <figure className="group-metric-chart">
      <figcaption>{title}</figcaption>
      {all.length === 0 ? (
        <p className="field-hint">此窗口没有可用读数；不按零负载绘制。</p>
      ) : (
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={id}>
          <title id={id}>
            {title}，{new Date(data.from).toLocaleString()} 至 {new Date(data.to).toLocaleString()}
          </title>
          <line x1="40" y1="14" x2="40" y2={height - 22} className="group-chart-axis" />
          <line
            x1="40"
            y1={height - 22}
            x2={width - 8}
            y2={height - 22}
            className="group-chart-axis"
          />
          <text x="36" y="13" textAnchor="end">
            {unit === 'B' || unit === 'B/s'
              ? formatDecimalBytes(String(Math.round(maximum)))
              : maximum.toFixed(0)}
          </text>
          <text x="32" y={height - 22} textAnchor="end">
            0
          </text>
          {keys.map((key, index) => {
            let last: number | null = null;
            const parts: string[] = [];
            for (const point of data.points) {
              const value = point.metrics[key];
              if (value == null) {
                last = null;
                continue;
              }
              parts.push(
                `${last === null || point.at - last > expectedGap ? 'M' : 'L'}${x(point).toFixed(2)},${y(value).toFixed(2)}`,
              );
              last = point.at;
            }
            return (
              <g key={key} className={`group-chart-series series-${index}`}>
                <path
                  d={parts.join(' ')}
                  fill="none"
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                />
                {data.points.length === 1 && data.points[0]?.metrics[key] != null ? (
                  <circle cx={x(data.points[0])} cy={y(data.points[0].metrics[key])} r="3" />
                ) : null}
              </g>
            );
          })}
          <text x="40" y={height - 3}>
            {new Date(data.from).toLocaleDateString()}
          </text>
          <text x={width - 8} y={height - 3} textAnchor="end">
            {new Date(data.to).toLocaleString()}
          </text>
        </svg>
      )}
      <ul className="group-chart-legend">
        {keys.map((key, index) => (
          <li key={key} className={`series-${index}`}>
            {METRICS[key].label} · {valueText(data.points.at(-1)?.metrics[key], METRICS[key].unit)}
          </li>
        ))}
      </ul>
    </figure>
  );
}
