/**
 * Carrier status auto-sync — mapping + selection logic (unit).
 *
 * The engine applies statuses through updateOrderStatusWebhook's forward-only
 * rank guard, so the one thing that must never be wrong is the mapping: an
 * unknown carrier string has to surface as "unmapped", never as a guess.
 */
import { describe, it, expect } from "vitest";
import { mapCarrierEvent, newestSignal } from "./auto-sync";
import { mapNoestStatus, normalizeCarrierKey } from "./noest/status-mapping";

describe("mapCarrierEvent — Yalidine", () => {
  it("maps the documented terminal statuses", () => {
    expect(mapCarrierEvent("yalidine", "Livré", null)).toMatchObject({ status: "delivered", known: true });
    expect(mapCarrierEvent("yalidine", "Retourné au vendeur", null)).toMatchObject({ status: "returned" });
    expect(mapCarrierEvent("yalidine", "Sorti en livraison", null)).toMatchObject({ status: "out_for_delivery" });
  });

  it("flags Tentative échouée as a failed attempt, not a transition", () => {
    expect(mapCarrierEvent("yalidine", "Tentative échouée", null).failedAttempt).toBe(true);
  });

  it("treats known transit strings as no-ops, not unmapped", () => {
    expect(mapCarrierEvent("yalidine", "En transit", null)).toMatchObject({ status: null, known: true });
  });

  it("never guesses an unknown string", () => {
    expect(mapCarrierEvent("yalidine", "Nouveau statut inconnu", null)).toMatchObject({
      status: null,
      known: false,
    });
  });
});

describe("mapCarrierEvent — EcoTrack family", () => {
  it("maps tracking activity keys", () => {
    expect(mapCarrierEvent("ecotrack", "dispatched_to_driver", null)).toMatchObject({ status: "out_for_delivery" });
    expect(mapCarrierEvent("packers_ecotrack", "livred", null)).toMatchObject({ status: "delivered" });
    expect(mapCarrierEvent("tnt_ecotrack", "return_in_transit", null)).toMatchObject({ status: "returned" });
  });

  it("treats notification_on_order as a known non-status event", () => {
    expect(mapCarrierEvent("ecotrack", "notification_on_order", null)).toMatchObject({ status: null, known: true });
  });

  it("surfaces unknown keys as unmapped", () => {
    expect(mapCarrierEvent("ecotrack", "etat_inconnu", null).known).toBe(false);
  });
});

describe("mapCarrierEvent — ZR Express", () => {
  it("maps default-workflow state names", () => {
    expect(mapCarrierEvent("zr_express", "en_livraison", null)).toMatchObject({ status: "out_for_delivery" });
    expect(mapCarrierEvent("zr_express", "livre", null)).toMatchObject({ status: "delivered" });
  });

  it("honours the admin custom mapping", () => {
    const custom = { delivered: ["Livraison effectuée"] };
    expect(mapCarrierEvent("zr_express", "Livraison effectuée", custom)).toMatchObject({ status: "delivered" });
  });

  it("treats an unmapped tenant state as a no-op (free-text vocabulary)", () => {
    expect(mapCarrierEvent("zr_express", "etat_sur_mesure", null)).toMatchObject({ status: null, known: true });
  });
});

describe("mapCarrierEvent — NOEST", () => {
  it("maps the platform vocabulary and honours overrides", () => {
    expect(mapCarrierEvent("noest", "en_livraison", null)).toMatchObject({ status: "out_for_delivery" });
    expect(mapCarrierEvent("noest", "STATUT MAISON", { delivered: ["Statut Maison"] })).toMatchObject({
      status: "delivered",
    });
  });

  it("surfaces unknown event keys as unmapped", () => {
    expect(mapCarrierEvent("noest", "cle_inconnue", null).known).toBe(false);
  });
});

describe("mapCarrierEvent — unknown provider", () => {
  it("never guesses for a carrier without a known vocabulary", () => {
    expect(mapCarrierEvent("some_new_carrier", "delivered", null).known).toBe(false);
  });
});

describe("newestSignal", () => {
  it("picks the latest dated event, not the last array entry", () => {
    const result = newestSignal(
      "yalidine",
      [
        { activity: "Livré", date: "2026-09-20 10:00:00" },
        { activity: "Sorti en livraison", date: "2026-09-20 08:00:00" },
      ],
      null,
    );
    expect(result.signal.status).toBe("delivered");
    expect(result.raw).toBe("Livré");
  });

  it("prefers a dated event over an undated one", () => {
    const result = newestSignal(
      "ecotrack",
      [
        { activity: "en_livraison" },
        { activity: "livred", date: "2026-09-20 09:00:00" },
      ],
      null,
    );
    expect(result.signal.status).toBe("delivered");
  });

  it("falls back to array order when nothing is dated", () => {
    const result = newestSignal(
      "ecotrack",
      [{ activity: "attempt_delivery" }, { activity: "return_in_transit" }],
      null,
    );
    expect(result.signal.status).toBe("returned");
  });

  it("returns a no-op signal for an empty history", () => {
    expect(newestSignal("yalidine", [], null)).toMatchObject({ raw: null, signal: { status: null, known: true } });
  });
});

describe("NOEST status mapping", () => {
  it("normalizes keys before lookup", () => {
    expect(normalizeCarrierKey("  En Livraison ")).toBe("en_livraison");
    expect(mapNoestStatus("EN LIVRAISON")).toBe("out_for_delivery");
  });

  it("reuses the EcoTrack platform vocabulary (activity and status keys)", () => {
    expect(mapNoestStatus("dispatched_to_driver")).toBe("out_for_delivery");
    expect(mapNoestStatus("en_livraison")).toBe("out_for_delivery");
    expect(mapNoestStatus("retour_recu")).toBe("returned");
  });

  it("returns undefined for unknown keys instead of guessing", () => {
    expect(mapNoestStatus("quelque_chose_dautre")).toBeUndefined();
  });
});
