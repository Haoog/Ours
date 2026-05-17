/** iPhone 实况：微信常返回「短视频 + thumbTempFilePath」 */

const LIVE_MAX_SEC = 4.5

export function isVideoPath(path: string): boolean {
  return /\.(mp4|mov|m4v|avi|wmv)(\?|$)/i.test(path)
}

/** 相册里的实况：时长很短且带缩略图路径 */
export function isLikelyLivePhotoFile(f: WechatMiniprogram.MediaFile): boolean {
  if (f.fileType !== 'video' && !isVideoPath(f.tempFilePath)) return false
  const dur = f.duration || 0
  if (dur <= 0 || dur > LIVE_MAX_SEC) return false
  return !!(f.thumbTempFilePath && f.thumbTempFilePath.length > 0)
}

export function isRegularVideoFile(f: WechatMiniprogram.MediaFile): boolean {
  const isVid = f.fileType === 'video' || isVideoPath(f.tempFilePath)
  return isVid && !isLikelyLivePhotoFile(f)
}
