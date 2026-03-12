import React, { useCallback, useState } from "react";
import { Box, Card, CardMedia, Chip, Tooltip, Typography } from "@mui/material";
import WarningIcon from "@mui/icons-material/Warning";
import { keyframes } from "@mui/system";
import type { PullSheetItem } from "../types/pullSheetTypes";
import {
  getConditionBackdropColor,
  getConditionBorderColor,
  getConditionChipColor,
  getConditionOverlay,
  getImageFilter,
  getPullSheetDisplayName,
  getTcgPlayerImageUrl,
  getVariantVisuals,
} from "./pullSheetUtils";
import type { PullSheetVariantVisuals } from "./pullSheetUtils";

interface PullSheetGridProps {
  items: PullSheetItem[];
}

const shimmerSweep = keyframes`
  0% {
    transform: translate(-116%, -116%) rotate(-18deg);
    opacity: 0;
  }

  16% {
    opacity: 0;
  }

  30% {
    opacity: 0.95;
  }

  48% {
    opacity: 0.5;
  }

  62%,
  100% {
    transform: translate(94%, 94%) rotate(-18deg);
    opacity: 0;
  }
`;

const shimmerSweepReverse = keyframes`
  0% {
    transform: translate(116%, 116%) rotate(-18deg);
    opacity: 0;
  }

  16% {
    opacity: 0;
  }

  30% {
    opacity: 0.95;
  }

  48% {
    opacity: 0.5;
  }

  62%,
  100% {
    transform: translate(-94%, -94%) rotate(-18deg);
    opacity: 0;
  }
`;

const ambientDrift = keyframes`
  0% {
    transform: scale(1) translate3d(-2%, -2%, 0);
    filter: hue-rotate(0deg);
  }

  50% {
    transform: scale(1.06) translate3d(2%, 2%, 0);
    filter: hue-rotate(18deg);
  }

  100% {
    transform: scale(1) translate3d(-2%, -2%, 0);
    filter: hue-rotate(0deg);
  }
`;

const firstEditionPulse = keyframes`
  0%,
  100% {
    opacity: 0.18;
    transform: scale(0.96);
  }

  50% {
    opacity: 0.34;
    transform: scale(1.05);
  }
`;

const badgeGlint = keyframes`
  0% {
    transform: translateX(-150%) skewX(-18deg);
    opacity: 0;
  }

  22% {
    opacity: 0;
  }

  36% {
    opacity: 0.72;
  }

  54%,
  100% {
    transform: translateX(160%) skewX(-18deg);
    opacity: 0;
  }
`;

interface VariantEffectLayersProps {
  variantVisuals: PullSheetVariantVisuals;
  shimmerDelay: string;
  pulseDelay: string;
}

function VariantEffectLayers({
  variantVisuals,
  shimmerDelay,
  pulseDelay,
}: VariantEffectLayersProps) {
  const shimmerMaskImage =
    variantVisuals.shimmerMaskImage ??
    [
      "linear-gradient(135deg, transparent 0%, rgba(0,0,0,0.18) 28%, rgba(0,0,0,0.82) 42%, #000 50%, rgba(0,0,0,0.82) 58%, rgba(0,0,0,0.18) 72%, transparent 100%)",
      "linear-gradient(135deg, transparent 0%, rgba(0,0,0,0.5) 18%, #000 34%, #000 66%, rgba(0,0,0,0.5) 82%, transparent 100%)",
    ].join(", ");

  return (
    <>
      {variantVisuals.ambientBackground !== "none" && (
        <Box
          sx={{
            position: "absolute",
            inset: 0,
            zIndex: 2,
            pointerEvents: "none",
            background: variantVisuals.ambientBackground,
            mixBlendMode:
              variantVisuals.effectType === "none" ? "screen" : "screen",
            opacity: variantVisuals.effectType === "none" ? 0.95 : 1,
            WebkitMaskImage: variantVisuals.shimmerMaskImage ?? undefined,
            maskImage: variantVisuals.shimmerMaskImage ?? undefined,
            animation:
              variantVisuals.effectType === "none"
                ? `${firstEditionPulse} 3.8s ease-in-out infinite`
                : `${ambientDrift} 8s ease-in-out infinite`,
            animationDelay: pulseDelay,
            "@media (prefers-reduced-motion: reduce)": {
              animation: "none",
              filter: "none",
              transform: "none",
              opacity: variantVisuals.effectType === "none" ? 0.3 : 0.24,
            },
          }}
        />
      )}

      {variantVisuals.effectType !== "none" && (
        <>
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              zIndex: 2,
              pointerEvents: "none",
              border: `1px solid ${variantVisuals.effectBorderColor}`,
              boxShadow: `inset 0 0 18px ${variantVisuals.effectBorderColor}`,
              borderRadius: 0.5,
            }}
          />
          <Box
            sx={{
              position: "absolute",
              inset: "-22%",
              zIndex: 2,
              pointerEvents: "none",
              background: variantVisuals.shimmerGradient,
              backgroundSize: "120% 120%",
              mixBlendMode: variantVisuals.shimmerBlendMode,
              opacity: variantVisuals.effectOpacity,
              WebkitMaskImage: shimmerMaskImage,
              maskImage: shimmerMaskImage,
              WebkitMaskSize: "100% 100%, 64% 64%",
              maskSize: "100% 100%, 64% 64%",
              WebkitMaskPosition: "center, center",
              maskPosition: "center, center",
              WebkitMaskRepeat: "no-repeat, no-repeat",
              maskRepeat: "no-repeat, no-repeat",
              filter: "blur(0.6px)",
              willChange: "transform, opacity",
              animation:
                variantVisuals.effectType === "reverse-holo"
                  ? `${shimmerSweepReverse} 5.6s linear infinite`
                  : `${shimmerSweep} 5.6s linear infinite`,
              animationDelay: shimmerDelay,
              "@media (prefers-reduced-motion: reduce)": {
                animation: "none",
                opacity: 0.16,
                transform: "none",
                backgroundPosition: "50% 50%",
              },
            }}
          />
        </>
      )}

      {variantVisuals.isFirstEdition && (
        <>
          <Box
            sx={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "42%",
              height: "30%",
              zIndex: 2,
              pointerEvents: "none",
              background:
                "radial-gradient(circle at 18% 18%, rgba(252, 211, 77, 0.42), rgba(251, 191, 36, 0.16) 38%, transparent 72%)",
              mixBlendMode: "screen",
              filter: "blur(8px)",
              animation: `${firstEditionPulse} 3.6s ease-in-out infinite`,
              animationDelay: pulseDelay,
              "@media (prefers-reduced-motion: reduce)": {
                animation: "none",
                filter: "blur(6px)",
                opacity: 0.24,
              },
            }}
          />
          {variantVisuals.badgeText && (
            <Box
              sx={{
                position: "absolute",
                top: 10,
                left: 10,
                zIndex: 2,
                px: 1,
                py: 0.4,
                borderRadius: 1,
                overflow: "hidden",
                border: "1px solid rgba(255,255,255,0.45)",
                background: variantVisuals.badgeBackground,
                color: "#fff7ed",
                fontSize: "0.68rem",
                fontWeight: 800,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                textShadow: "0 1px 2px rgba(0,0,0,0.55)",
                boxShadow: `0 4px 10px rgba(0,0,0,0.18), ${variantVisuals.badgeGlow}`,
                "&::after": {
                  content: '""',
                  position: "absolute",
                  inset: "-25%",
                  background:
                    "linear-gradient(112deg, transparent 34%, rgba(255,255,255,0) 42%, rgba(255,255,255,0.72) 50%, rgba(255,255,255,0) 58%, transparent 66%)",
                  transform: "translateX(-150%) skewX(-18deg)",
                  animation: `${badgeGlint} 4.8s linear infinite`,
                  animationDelay: pulseDelay,
                },
                "@media (prefers-reduced-motion: reduce)": {
                  "&::after": {
                    animation: "none",
                    opacity: 0.18,
                    transform: "translateX(0) skewX(-18deg)",
                  },
                },
              }}
            >
              {variantVisuals.badgeText}
            </Box>
          )}
        </>
      )}
    </>
  );
}

export const PullSheetGrid: React.FC<PullSheetGridProps> = React.memo(
  ({ items }) => {
    const [hiddenInfoKeys, setHiddenInfoKeys] = useState<Record<string, boolean>>(
      {},
    );

    const handleToggleInfo = useCallback((itemKey: string) => {
      setHiddenInfoKeys((current) => ({
        ...current,
        [itemKey]: !current[itemKey],
      }));
    }, []);

    return (
      <Box>
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            gap: 2,
          }}
        >
          {items.map((item, index) => {
            const itemKey = `${item.skuId}-${index}`;
            const condition = item.dbCondition || item.condition;
            const variant = item.variant || "";
            const backdropColor = getConditionBackdropColor(condition);
            const borderColor = getConditionBorderColor(condition);
            const overlay = getConditionOverlay(condition);
            const variantVisuals = getVariantVisuals(variant);
            const imageFilter = getImageFilter(condition);
            const displayName = getPullSheetDisplayName(
              item.productName,
              item.number,
            );
            const isInfoHidden = !!hiddenInfoKeys[itemKey];
            const shimmerDelay = `${(index % 8) * 0.55}s`;
            const pulseDelay = `${((index * 3) % 10) * 0.35}s`;
            const metaLine = [item.set, item.releaseYear].filter(Boolean).join(
              " | ",
            );

            return (
              <Card
                key={itemKey}
                sx={{
                  position: "relative",
                  border: `3px solid ${borderColor}`,
                  borderRadius: 2,
                  overflow: "hidden",
                  boxShadow:
                    variantVisuals.glow !== "none"
                      ? variantVisuals.glow
                      : undefined,
                  transition: "all 0.2s ease",
                  "&:hover": {
                    transform: "translateY(-2px)",
                    boxShadow: `${
                      variantVisuals.glow !== "none"
                        ? `${variantVisuals.glow},`
                        : ""
                    } 0 4px 12px rgba(0,0,0,0.15)`,
                  },
                }}
              >
                {overlay !== "none" && (
                  <Box
                    sx={{
                      position: "absolute",
                      inset: 0,
                      background: overlay,
                      zIndex: 1,
                      pointerEvents: "none",
                    }}
                  />
                )}

                {item.quantity > 1 && (
                  <Chip
                    label={`x${item.quantity}`}
                    color="primary"
                    size="small"
                    sx={{
                      position: "absolute",
                      top: 8,
                      right: 8,
                      zIndex: 4,
                      fontWeight: 700,
                    }}
                  />
                )}

                <Box
                  sx={{
                    position: "relative",
                    aspectRatio: "3 / 4",
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    overflow: "hidden",
                    backgroundColor: "action.hover",
                    cursor: item.productId ? "pointer" : "default",
                  }}
                  onClick={() => {
                    if (item.productId) {
                      handleToggleInfo(itemKey);
                    }
                  }}
                >
                  {item.productId ? (
                    <CardMedia
                      component="img"
                      image={getTcgPlayerImageUrl(item.productId, "400x400")}
                      alt={displayName}
                      sx={{
                        width: "100%",
                        height: "100%",
                        objectFit: "contain",
                        filter: imageFilter,
                        p: 0,
                      }}
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = "none";
                      }}
                    />
                  ) : (
                    <Tooltip title="Product not found in database">
                      <WarningIcon sx={{ fontSize: 48, color: "warning.main" }} />
                    </Tooltip>
                  )}

                  {item.productId && (
                    <VariantEffectLayers
                      variantVisuals={variantVisuals}
                      shimmerDelay={shimmerDelay}
                      pulseDelay={pulseDelay}
                    />
                  )}

                  {!isInfoHidden && (
                    <Box
                      sx={{
                        position: "absolute",
                        inset: 0,
                        zIndex: 3,
                        display: "flex",
                        alignItems: "flex-end",
                        color: "common.white",
                        pointerEvents: "none",
                      }}
                    >
                      <Box
                        sx={{
                          width: "100%",
                          px: 1,
                          py: 0.75,
                          backgroundColor: backdropColor,
                          borderTop: `1px solid ${borderColor}99`,
                        }}
                      >
                        <Typography
                          variant="body2"
                          sx={{
                            fontWeight: 700,
                            fontSize: "0.8rem",
                            lineHeight: 1.2,
                            mb: 0.5,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            display: "-webkit-box",
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: "vertical",
                            textShadow: "0 2px 6px rgba(0,0,0,0.95)",
                          }}
                        >
                          {displayName}
                        </Typography>

                        {metaLine && (
                          <Typography
                            variant="caption"
                          sx={{
                            display: "block",
                            mb: 0.75,
                            color: "rgba(255,255,255,0.92)",
                            textShadow: "0 1px 3px rgba(0,0,0,0.95)",
                          }}
                        >
                          {metaLine}
                        </Typography>
                        )}

                        <Box
                          sx={{
                            display: "flex",
                            gap: 0.5,
                            flexWrap: "wrap",
                            mb: 0.5,
                          }}
                        >
                          <Chip
                            label={condition}
                            color={getConditionChipColor(condition)}
                            size="small"
                            variant="filled"
                            sx={{ fontSize: "0.7rem", height: 22 }}
                          />
                          {variantVisuals.label && (
                            <Chip
                              label={variantVisuals.label}
                              size="small"
                              variant="outlined"
                              sx={{
                                fontSize: "0.7rem",
                                height: 22,
                                backgroundColor: "rgba(0,0,0,0.32)",
                                borderColor: variantVisuals.chipBorderColor,
                                color: variantVisuals.chipTextColor,
                                fontStyle: variantVisuals.chipFontStyle,
                                fontWeight: variantVisuals.chipFontWeight,
                              }}
                            />
                          )}
                        </Box>

                        <Typography
                          variant="caption"
                        sx={{
                          display: "block",
                          fontSize: "0.7rem",
                          color: "rgba(255,255,255,0.88)",
                          textShadow: "0 1px 3px rgba(0,0,0,0.95)",
                        }}
                      >
                        {item.productLine} | {item.rarity}
                        </Typography>
                      </Box>
                    </Box>
                  )}
                </Box>
              </Card>
            );
          })}
        </Box>
      </Box>
    );
  },
);
