import type { ArchiveRetryImpact } from '@ptvault/contracts';
import { formatDecimalBytes } from './importFormatting.js';

export function RetryImpactNote({ impact }: { impact: ArchiveRetryImpact | undefined }) {
  let summary = '尚不能估算重新下载或解压的代价；重试时会先核对来源和已有检查点。';
  if (impact?.mode === 'REUSE_OUTPUTS')
    summary =
      '已有完整视频结果记录，预计无需重新下载或解压；继续未完成的上传、校验或收尾，仍可能回读并校验已有文件。';
  else if (impact?.mode === 'REUSE_INPUTS')
    summary = '输入检查点已齐，预计无需重新下载；解压过程不能从一半续接，需要重新解压。';
  else if (impact?.mode === 'RESUME_INPUTS')
    summary = `已有输入检查点 ${formatDecimalBytes(impact.retainedInputBytes ?? '0')}，预计还需下载 ${formatDecimalBytes(impact.downloadBytes ?? '0')}；之后重新解压。`;
  else if (impact?.mode === 'REDOWNLOAD_INPUTS')
    summary = `当前没有可续接的输入检查点，预计需下载 ${formatDecimalBytes(impact.downloadBytes ?? '0')} 并重新解压；只处理本任务，已完成的其他组不重复。`;
  return (
    <div className="field-hint" role="note" aria-label="重试代价">
      <p>{summary}</p>
      <p>
        这是保存记录的估算，不是刚完成的磁盘检查。实际下载量以执行时的核验结果为准，仍保留原有的校验与防误删保护。
      </p>
    </div>
  );
}
