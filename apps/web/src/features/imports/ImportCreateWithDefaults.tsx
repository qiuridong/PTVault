import { useQuery } from '@tanstack/react-query';
import { getNetdiskSettings, netdiskSettingsQueryKey } from '../settings/netdiskSettingsApi.js';
import { ImportCreatePanel } from './ImportCreatePanel.js';

/** A new form must not silently trust defaults cached by an earlier visit. */
export function ImportCreateWithDefaults(
  props: Omit<Parameters<typeof ImportCreatePanel>[0], 'defaults'>,
) {
  const query = useQuery({
    queryKey: netdiskSettingsQueryKey,
    queryFn: getNetdiskSettings,
    refetchOnMount: 'always',
    retry: false,
  });
  if (!query.isFetchedAfterMount) return <p role="status">正在读取已保存的新任务默认设置……</p>;
  const defaults = !query.isError && query.data?.supported === true ? query.data.data.configured : null;
  return <>
    {defaults === null ? <p role="status">未能读取默认设置，请明确选择目标账户与发布策略；不会自动改用首个 Raw 目标。</p> : null}
    <ImportCreatePanel {...props} defaults={defaults} />
  </>;
}
