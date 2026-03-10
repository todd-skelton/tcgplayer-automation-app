import React, { useCallback, useState } from "react";
import { Box, Card, CardMedia, Chip, Tooltip, Typography } from "@mui/material";
import WarningIcon from "@mui/icons-material/Warning";
import type { PullSheetItem } from "../types/pullSheetTypes";
import {
  getConditionBackdropColor,
  getConditionBorderColor,
  getConditionChipColor,
  getConditionOverlay,
  getImageFilter,
  getPullSheetDisplayName,
  getTcgPlayerImageUrl,
  getVariantGlow,
  getVariantLabel,
} from "./pullSheetUtils";

interface PullSheetGridProps {
  items: PullSheetItem[];
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
            const glow = getVariantGlow(variant);
            const imageFilter = getImageFilter(condition);
            const displayName = getPullSheetDisplayName(
              item.productName,
              item.number,
            );
            const isInfoHidden = !!hiddenInfoKeys[itemKey];
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
                  boxShadow: glow !== "none" ? glow : undefined,
                  transition: "all 0.2s ease",
                  "&:hover": {
                    transform: "translateY(-2px)",
                    boxShadow: `${
                      glow !== "none" ? `${glow},` : ""
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
                          {variant && variant !== "Normal" && (
                            <Chip
                              label={getVariantLabel(variant)}
                              size="small"
                              variant="outlined"
                              sx={{
                                fontSize: "0.7rem",
                                height: 22,
                                backgroundColor: "rgba(0,0,0,0.32)",
                                borderColor: variant.toLowerCase().includes("holo")
                                  ? "#FFD700"
                                  : "rgba(255,255,255,0.45)",
                                color: variant.toLowerCase().includes("holo")
                                  ? "#FFD700"
                                  : "common.white",
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
