import {
  Box,
  Card,
  CardActionArea,
  CardContent,
  Typography,
} from "@mui/material";
import { Link, type MetaFunction } from "react-router";
import { dashboardCards } from "../shared/appNavigation";

export const meta: MetaFunction = () => {
  return [
    { title: "TCGPlayer Automation" },
    {
      name: "description",
      content: "TCGPlayer inventory and pricing automation tools",
    },
  ];
};

export default function DashboardRoute() {
  return (
    <Box sx={{ maxWidth: 960, mx: "auto", p: 3 }}>
      <Typography variant="h4" component="h1" fontWeight={700} gutterBottom>
        TCGPlayer Automation
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
        Inventory and pricing automation tools
      </Typography>

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: {
            xs: "1fr",
            sm: "1fr 1fr",
            md: "1fr 1fr 1fr",
          },
          gap: 3,
        }}
      >
        {dashboardCards.map((card) => {
          const Icon = card.icon;

          return (
            <Card
              key={card.to}
              elevation={2}
              sx={{
                transition: "box-shadow 0.2s, transform 0.2s",
                "&:hover": {
                  boxShadow: 6,
                  transform: "translateY(-2px)",
                },
              }}
            >
              <CardActionArea
                component={Link}
                to={card.to}
                sx={{ height: "100%", p: 1 }}
              >
                <CardContent
                  sx={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "flex-start",
                    gap: 1,
                  }}
                >
                  <Icon sx={{ fontSize: 40, color: card.color }} />
                  <Typography variant="h6" component="h2" fontWeight={600}>
                    {card.title}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {card.description}
                  </Typography>
                </CardContent>
              </CardActionArea>
            </Card>
          );
        })}
      </Box>
    </Box>
  );
}
