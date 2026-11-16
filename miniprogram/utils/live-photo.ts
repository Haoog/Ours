export function isVideoPath(path: string): boolean {
  return /\.(mp4|mov|m4v|avi|wmv)(\?|$)/i.test(path)
}

/** 时长和缩略图不能证明视频是实况。 */
export function isRegularVideoFile(f: WechatMiniprogram.MediaFile): boolean {
  return f.fileType === 'video' || isVideoPath(f.tempFilePath)
}

/** 仅供用户明确选择实况入口后检查是否具备所需素材。 */
export function canUseAsLivePhoto(f: WechatMiniprogram.MediaFile): boolean {
  return isRegularVideoFile(f) && !!f.thumbTempFilePath
}
