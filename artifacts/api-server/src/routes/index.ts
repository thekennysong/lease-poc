import { Router, type IRouter } from "express";
import healthRouter from "./health";
import leasesRouter from "./leases";
import qboRouter from "./qbo";

const router: IRouter = Router();

router.use(healthRouter);
router.use(leasesRouter);
router.use(qboRouter);

export default router;
