import { Router, type IRouter } from "express";
import healthRouter from "./health";
import leasesRouter from "./leases";

const router: IRouter = Router();

router.use(healthRouter);
router.use(leasesRouter);

export default router;
