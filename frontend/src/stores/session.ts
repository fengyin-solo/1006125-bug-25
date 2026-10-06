import { defineStore } from 'pinia'

import { RING_CREWS } from '@/data/ring-domain'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '盾构隧道掘进施工管理平台',
    // 当前登录的掘进班组：只有本班组能确认自己区间里的环次。
    crew: RING_CREWS[0],
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    crewOptions: () => ['注浆班', ...RING_CREWS],
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setCrew(crew: string) {
      this.crew = crew
    },
  },
})
