import { defineStore } from 'pinia'

import { CONFIRM_CREWS, sectionOfCrew } from '@/data/ring-domain'

// 当前登录班组：只有本掘进班组能确认自己区间里的环次，跨班组、越级一律不收。
export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    currentCrew: CONFIRM_CREWS[0] ?? '',
    shiftLabel: '白班 08:00-20:00',
    scope: '盾构隧道掘进施工管理平台',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    currentSection(state): string {
      return sectionOfCrew(state.currentCrew)
    },
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setCurrentCrew(crew: string) {
      this.currentCrew = crew
    },
  },
})
