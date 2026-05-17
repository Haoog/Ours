// utils/avatar.ts — 选择并上传当前用户头像

import { getIdentity, updateProfile, uploadAvatar } from '../services/store'

function pickWithChooseImage(sourceType: ('album' | 'camera')[]): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.chooseImage({
      count: 1,
      sizeType: ['compressed'],
      sourceType,
      success: res => {
        const path = res.tempFilePaths?.[0]
        if (path) resolve(path)
        else reject(new Error('未选到图片'))
      },
      fail: reject,
    })
  })
}

function pickWithChooseMedia(sourceType: ('album' | 'camera')[]): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType,
      success: res => {
        const path = res.tempFiles?.[0]?.tempFilePath
        if (path) resolve(path)
        else reject(new Error('未选到图片'))
      },
      fail: reject,
    })
  })
}

export function pickLocalAvatar(): Promise<string> {
  return new Promise((resolve, reject) => {
    wx.showActionSheet({
      itemList: ['从相册选择', '拍照'],
      success: async sheet => {
        if (sheet.tapIndex == null || sheet.tapIndex < 0) {
          reject(new Error('cancel'))
          return
        }
        const sourceType: ('album' | 'camera')[] = sheet.tapIndex === 1 ? ['camera'] : ['album']
        try {
          resolve(await pickWithChooseImage(sourceType))
        } catch {
          try {
            resolve(await pickWithChooseMedia(sourceType))
          } catch (err) {
            reject(err)
          }
        }
      },
      fail: err => {
        if (err?.errMsg?.includes('cancel')) reject(new Error('cancel'))
        else reject(err)
      },
    })
  })
}

export async function saveMyAvatar(tempFilePath: string): Promise<void> {
  const fileID = await uploadAvatar(tempFilePath)
  const { nickname } = getIdentity()
  await updateProfile({ nickname, avatarUrl: fileID })
}

export function canEditAvatarSlot(slot: 'A' | 'B', myRole: 'A' | 'B'): boolean {
  return slot === myRole
}

/** 更换自己的头像；成功返回 true */
export async function changeAvatarForSlot(slot: 'A' | 'B', myRole: 'A' | 'B'): Promise<boolean> {
  if (!canEditAvatarSlot(slot, myRole)) {
    wx.showToast({ title: '只能更换自己的头像', icon: 'none' })
    return false
  }
  try {
    const path = await pickLocalAvatar()
    wx.showLoading({ title: '上传中' })
    await saveMyAvatar(path)
    wx.showToast({ title: '头像已更新', icon: 'success' })
    return true
  } catch (err) {
    if (err instanceof Error && err.message === 'cancel') return false
    const msg = err instanceof Error ? err.message : '上传失败'
    wx.showToast({ title: msg, icon: 'none' })
    return false
  } finally {
    wx.hideLoading()
  }
}
