import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { getStoredAllowedModules, getStoredUsername, setStoredAllowedModules } from '@/api/client'
import { fetchCurrentUser, fetchMyAvatar, type UserAvatar } from '@/api/studio/auth'

export const useAccountStore = defineStore('account', () => {
  const username = ref(getStoredUsername() || '')
  const allowedModules = ref<string[] | null>(getStoredAllowedModules())
  const avatar = ref<UserAvatar | null>(null)
  const profileAvatar = computed(() => avatar.value?.type === 'image'
    ? { type: 'image' as const, dataUrl: avatar.value.dataUrl }
    : null)
  let loaded = false
  let pending: Promise<void> | null = null

  function loadAccount(): Promise<void> {
    if (pending) return pending
    if (loaded) return Promise.resolve()
    pending = Promise.allSettled([fetchCurrentUser(), fetchMyAvatar()])
      .then(([userResult, avatarResult]) => {
        if (userResult.status === 'fulfilled') {
          username.value = userResult.value.username
          allowedModules.value = userResult.value.allowedModules
          setStoredAllowedModules(userResult.value.allowedModules)
        }
        if (avatarResult.status === 'fulfilled') avatar.value = avatarResult.value
        loaded = userResult.status === 'fulfilled' && avatarResult.status === 'fulfilled'
      })
      .finally(() => { pending = null })
    return pending
  }

  function refreshAccount(): Promise<void> {
    loaded = false
    return loadAccount()
  }

  return { username, allowedModules, avatar, profileAvatar, loadAccount, refreshAccount }
})
