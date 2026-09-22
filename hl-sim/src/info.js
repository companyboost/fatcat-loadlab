// The `info` POST router.
//
// Returning `undefined` means "not handled" and the server answers 501 loudly.
// That is deliberate: an unhandled type quietly answering `{}` is how a
// simulator produces a confidently wrong measurement.

import { SPOT_ASSETS } from "./world.js";
import {
  buildAllMids,
  buildCandleSnapshot,
  buildClearinghouseState,
  buildL2Book,
  buildMetaAndAssetCtxs,
  buildSpotClearinghouseState,
  buildSpotMeta,
  buildSpotMetaAndAssetCtxs,
  buildUserAbstraction,
  buildUserFillsByTime,
  buildUserFunding,
  buildUserNonFundingLedger,
  buildUserRateLimit,
} from "./shapes.js";

export function handleInfo(body) {
  const now = Date.now();
  const type = body?.type;
  const user = body?.user;

  switch (type) {
    case "clearinghouseState":
      return buildClearinghouseState(user, now);

    case "spotClearinghouseState":
      return buildSpotClearinghouseState(user, now);

    case "userAbstraction":
      return buildUserAbstraction(user);

    case "userFillsByTime":
      return buildUserFillsByTime(user, body.startTime ?? now - 60_000, body.endTime ?? now);

    case "userFills":
      return buildUserFillsByTime(user, now - 60_000, now);

    case "userFunding":
      return buildUserFunding(user, body.startTime ?? now - 60_000);

    case "userNonFundingLedgerUpdates":
      return buildUserNonFundingLedger(user, body.startTime ?? now - 60_000);

    case "metaAndAssetCtxs":
      return buildMetaAndAssetCtxs(now);

    case "spotMetaAndAssetCtxs":
      return buildSpotMetaAndAssetCtxs(now, SPOT_ASSETS);

    // Called bare by duel-scoring-service, hl-faucet and prediction-rail. It
    // must be element 0 of the tuple above; the last two THROW if no token is
    // named exactly "USDC".
    case "spotMeta":
      return buildSpotMeta(SPOT_ASSETS);

    case "l2Book":
      return buildL2Book(body.coin, now);

    case "allMids":
      return buildAllMids(now);

    case "userRateLimit":
      return buildUserRateLimit();

    case "candleSnapshot": {
      const req = body.req ?? {};
      return buildCandleSnapshot(req.coin, req.interval ?? "1m", req.startTime ?? now - 3_600_000, req.endTime);
    }

    default:
      return undefined;
  }
}
