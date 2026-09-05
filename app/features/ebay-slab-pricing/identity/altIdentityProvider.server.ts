import {
  createProviderRequest,
  ProviderRequestError,
} from "../connections/providerRequest.server";
import {
  normalizeCertificate,
  parseSlabIdentity,
  type IdentityCandidate,
} from "./slabIdentity";

const CERT_QUERY = `query Cert($certNumber: String!) {
  cert(certNumber: $certNumber) {
    certNumber gradeNumber gradingCompany autograph qualifier
    asset { id name year subject category brand variety attributes { cardNumber } }
  }
}`;

export function parseAltCertificate(body: string): IdentityCandidate | null {
  try {
    const result = JSON.parse(body);
    if (
      result?.errors?.some?.(
        (error: { extensions?: { code?: string } }) =>
          error?.extensions?.code === "UNAUTHENTICATED",
      )
    ) {
      throw new ProviderRequestError("reconnect-required");
    }
    if (result?.errors?.length || !result?.data || !("cert" in result.data))
      throw new ProviderRequestError("invalid-response");
    const cert = result.data.cert;
    if (cert === null) return null;
    const certificate = normalizeCertificate({
      grader: cert.gradingCompany,
      certificateNumber: cert.certNumber,
    });
    if (
      typeof cert.gradeNumber !== "string" ||
      !cert.gradeNumber ||
      typeof cert.asset?.id !== "string" ||
      !cert.asset.id
    ) {
      throw new ProviderRequestError("invalid-response");
    }
    const numeric = /^\d+(?:\.\d+)?$/.test(cert.gradeNumber)
      ? Number(cert.gradeNumber)
      : NaN;
    // PSA's scale is verified. Other provider encodings need an explicit label decision.
    const number =
      certificate.grader === "PSA" &&
      numeric >= 1 &&
      numeric <= 10 &&
      numeric !== 9.5 &&
      (numeric * 2) % 1 === 0
        ? numeric
        : null;
    return {
      ...certificate,
      identity: parseSlabIdentity({
        card: {
          name: cert.asset.subject ?? cert.asset.name,
          game: cert.asset.category === "POKEMON_CARDS" ? "Pokemon" : null,
          language: null,
          set: cert.asset.brand ?? null,
          cardNumber: cert.asset.attributes?.cardNumber ?? null,
          year: cert.asset.year == null ? null : String(cert.asset.year),
          edition: cert.asset.variety === "1st Edition" ? "1st Edition" : null,
          finish: ["Reverse Holo", "Holo", "Non-Holo"].includes(
            cert.asset.variety,
          )
            ? cert.asset.variety
            : null,
          stamp: null,
        },
        grading: {
          grader: certificate.grader,
          encoding: cert.gradeNumber,
          number,
          label: number === null ? null : `PSA ${number}`,
          qualifier: cert.qualifier,
          autograph: cert.autograph,
        },
        providerAsset: {
          provider: "alt",
          id: cert.asset.id,
          title: cert.asset.name,
        },
      }),
    };
  } catch (error) {
    throw error instanceof ProviderRequestError
      ? error
      : new ProviderRequestError("invalid-response");
  }
}

export function createAltIdentityProvider(
  request: ReturnType<typeof createProviderRequest>,
) {
  return async (
    certificateNumber: string,
    signal?: AbortSignal,
  ): Promise<IdentityCandidate | null> => {
    let candidate: IdentityCandidate | null = null;
    await request(
      "alt",
      {
        path: "/graphql/Cert",
        body: JSON.stringify({
          operationName: "Cert",
          variables: { certNumber: certificateNumber },
          query: CERT_QUERY,
        }),
      },
      {
        signal,
        validate: (body) => {
          candidate = parseAltCertificate(body);
        },
      },
    );
    return candidate;
  };
}
