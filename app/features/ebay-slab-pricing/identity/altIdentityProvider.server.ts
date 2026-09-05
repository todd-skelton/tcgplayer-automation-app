import {
  createProviderRequest,
  ProviderRequestError,
} from "../connections/providerRequest.server";
import {
  normalizeCertificate,
  parseSlabIdentity,
  type IdentityCandidate,
} from "./slabIdentity";
import { altCard, altGrading } from "./altIdentityFields.server";

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
    return {
      ...certificate,
      identity: parseSlabIdentity({
        card: altCard(cert.asset),
        grading: altGrading(cert),
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
