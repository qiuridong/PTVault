import { useId, useState } from 'react';
export function ArchiveCandidatesField({
  value,
  onChange,
  disabled = false,
}: {
  value: readonly string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
}) {
  const id = useId(),
    [visible, setVisible] = useState(false),
    [error, setError] = useState<string | null>(null);
  const values = value.length === 0 ? [''] : value;
  return (
    <fieldset disabled={disabled} className="archive-candidates">
      <legend>候选解压密码（每层独立尝试）</legend>
      <p className="field-hint">
        先尝试无密码，再按顺序尝试整份列表。可在任一密码框粘贴多行；不猜测或生成密码，最多 32
        个。空格会原样保留。
      </p>
      {values.map((entry, index) => (
        <div className="field" key={index}>
          <label htmlFor={`${id}-${index}`}>候选解压密码 {index + 1}</label>
          <input
            id={`${id}-${index}`}
            type={visible ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            maxLength={256}
            value={entry}
            onChange={(event) => {
              const next = [...values];
              next[index] = event.target.value;
              onChange(next);
              setError(null);
            }}
            onPaste={(event) => {
              const pasted = event.clipboardData.getData('text');
              if (!/[\r\n]/.test(pasted)) return;
              event.preventDefault();
              const lines = pasted.split(/\r\n|\r|\n/).filter((line) => line !== '');
              const next = [...values.slice(0, index), ...lines, ...values.slice(index + 1)];
              if (
                next.length > 32 ||
                next.some((line) => line.length > 256 || line.includes('\0'))
              ) {
                setError('密码列表超限：最多 32 个，每个最多 256 字符。');
                return;
              }
              onChange(next);
              setError(null);
            }}
          />
          {values.length > 1 ? (
            <button
              type="button"
              className="ghost-button"
              aria-label={`移除密码 ${index + 1}`}
              onClick={() => onChange(values.filter((_, i) => i !== index))}
            >
              移除
            </button>
          ) : null}
        </div>
      ))}
      <button
        type="button"
        className="ghost-button"
        disabled={values.length >= 32}
        onClick={() => onChange([...values, ''])}
      >
        添加候选密码
      </button>{' '}
      <button type="button" className="ghost-button" onClick={() => setVisible(!visible)}>
        {visible ? '隐藏候选密码' : '显示候选密码'}
      </button>
      <p className="field-hint">
        请求交付后清空浏览器输入。服务端限时加密保存，视频准备完成后销毁；失败可在任务详情重新提供。
      </p>
      {error === null ? null : <p role="alert">{error}</p>}
    </fieldset>
  );
}
