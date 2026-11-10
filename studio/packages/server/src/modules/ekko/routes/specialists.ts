import Router from '@koa/router'
import * as ctrl from '../controllers/specialists'

export const ekkoSpecialistRoutes = new Router()

ekkoSpecialistRoutes.get('/api/ekko/agent/specialists', ctrl.list)
ekkoSpecialistRoutes.patch('/api/ekko/agent/specialists/:id', ctrl.update)
