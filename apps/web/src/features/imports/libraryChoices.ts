import {
  importLibraryAcceptsMediaType,
  type ImportMediaType,
  type JellyfinImportLibrary,
} from '@ptvault/contracts';

export const LIBRARY_TYPE_LABELS: Record<JellyfinImportLibrary['contentType'], string> = {
  Movies: '电影',
  Shows: '剧集',
  HomeVideos: '独立视频',
  Mixed: '混合内容',
  Photos: '图片',
  Collections: '合集',
  Other: '其他类型',
};
const REASONS: Record<NonNullable<JellyfinImportLibrary['unavailableReason']>, string> = {
  PHOTOS_ONLY: '图片专用，不接收视频',
  COLLECTION_ONLY: '仅组织已有媒体，不是文件目标',
  TYPE_UNSUPPORTED: '此类型不接收本次视频',
  PATH_UNMAPPED: '尚未配置可读的发布路径',
  DISCOVERY_UNAVAILABLE: '库清单暂不可用，请刷新',
};
export function libraryChoiceReason(
  library: JellyfinImportLibrary,
  mediaType: ImportMediaType,
): string | null {
  if (library.unavailableReason != null) return REASONS[library.unavailableReason];
  if (importLibraryAcceptsMediaType(mediaType, library.contentType)) return null;
  if (library.contentType === 'HomeVideos') return '这个媒体库收独立视频，不使用剧集类型。';
  if (library.contentType === 'Movies') return '这个媒体库只收电影，与所选媒体类型不相容。';
  if (library.contentType === 'Shows') return '这个媒体库只收剧集，与所选媒体类型不相容。';
  return '这个媒体库不接收视频。';
}
export function libraryOptionLabel(
  library: JellyfinImportLibrary,
  mediaType: ImportMediaType,
): string {
  const reason = libraryChoiceReason(library, mediaType);
  return `${library.displayName} · ${LIBRARY_TYPE_LABELS[library.contentType]}${reason === null ? '' : `（${reason}）`}`;
}
