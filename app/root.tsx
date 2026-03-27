import React from "react";
import {
  Link,
  data,
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
  useLocation,
} from "react-router";
import {
  Alert,
  AppBar,
  Box,
  CssBaseline,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  ThemeProvider,
  Toolbar,
  Tooltip,
  Typography,
  createTheme,
} from "@mui/material";
import useMediaQuery from "@mui/material/useMediaQuery";
import MenuIcon from "@mui/icons-material/Menu";
import SettingsIcon from "@mui/icons-material/Settings";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";

import type { Route } from "./+types/root";
import { getHttpConfig } from "./core/config/httpConfig.server";
import {
  primaryNavigationItems,
  settingsNavigationItems,
} from "./shared/appNavigation";

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap",
  },
];

export async function loader() {
  const httpConfig = await getHttpConfig();
  return data({ hasAuthCookie: !!httpConfig.tcgAuthCookie });
}

export function Layout({ children }: { children: React.ReactNode }) {
  const prefersDarkMode = useMediaQuery("(prefers-color-scheme: dark)");
  const theme = createTheme({
    palette: {
      mode: prefersDarkMode ? "dark" : "light",
    },
  });

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <ThemeProvider theme={theme}>
          <CssBaseline />
          {children}
          <ScrollRestoration />
          <Scripts />
        </ThemeProvider>
      </body>
    </html>
  );
}

export default function App() {
  const { hasAuthCookie } = useLoaderData<typeof loader>();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [settingsAnchorEl, setSettingsAnchorEl] =
    React.useState<null | HTMLElement>(null);

  const isCurrentPath = (path: string) => location.pathname === path;
  const settingsActive = settingsNavigationItems.some((item) =>
    isCurrentPath(item.to),
  );

  return (
    <>
      <AppBar position="fixed">
        <Toolbar>
          <IconButton
            color="inherit"
            edge="start"
            onClick={() => setMobileOpen(true)}
            sx={{ mr: 1, display: { sm: "none" } }}
          >
            <MenuIcon />
          </IconButton>

          <Typography
            variant="h6"
            component={Link}
            to="/"
            sx={{
              textDecoration: "none",
              color: "inherit",
              fontWeight: 700,
              mr: 3,
              flexShrink: 0,
            }}
          >
            TCGPlayer Automation
          </Typography>

          <Box
            sx={{
              display: { xs: "none", sm: "flex" },
              gap: 0.5,
              flexGrow: 1,
              overflow: "auto",
            }}
          >
            {primaryNavigationItems.map((item) => (
              <MenuItem
                key={item.to}
                component={Link}
                to={item.to}
                sx={{
                  color: "inherit",
                  borderBottom: isCurrentPath(item.to)
                    ? "2px solid white"
                    : "2px solid transparent",
                  borderRadius: 0,
                  minWidth: "auto",
                  px: 1.5,
                  whiteSpace: "nowrap",
                }}
              >
                {item.label}
              </MenuItem>
            ))}
          </Box>

          <Box sx={{ display: "flex", alignItems: "center", ml: "auto" }}>
            {!hasAuthCookie && (
              <Tooltip title="Auth cookie not configured">
                <IconButton
                  color="inherit"
                  component={Link}
                  to="/http-configuration"
                  size="small"
                >
                  <WarningAmberIcon sx={{ color: "warning.light" }} />
                </IconButton>
              </Tooltip>
            )}

            <Tooltip title="Settings">
              <IconButton
                color="inherit"
                onClick={(event) => setSettingsAnchorEl(event.currentTarget)}
                sx={{
                  border: settingsActive
                    ? "1px solid rgba(255,255,255,0.5)"
                    : "none",
                }}
              >
                <SettingsIcon />
              </IconButton>
            </Tooltip>

            <Menu
              anchorEl={settingsAnchorEl}
              open={Boolean(settingsAnchorEl)}
              onClose={() => setSettingsAnchorEl(null)}
            >
              {settingsNavigationItems.map((item) => {
                const Icon = item.icon;

                return (
                  <MenuItem
                    key={item.to}
                    component={Link}
                    to={item.to}
                    selected={isCurrentPath(item.to)}
                    onClick={() => setSettingsAnchorEl(null)}
                  >
                    <ListItemIcon>
                      <Icon fontSize="small" />
                    </ListItemIcon>
                    <ListItemText>{item.label}</ListItemText>
                  </MenuItem>
                );
              })}
            </Menu>
          </Box>
        </Toolbar>
      </AppBar>

      <Drawer
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        variant="temporary"
        ModalProps={{ keepMounted: true }}
      >
        <Box sx={{ width: 260 }}>
          <Typography variant="h6" sx={{ p: 2, fontWeight: 700 }}>
            Navigation
          </Typography>
          <Divider />

          <List>
            {primaryNavigationItems.map((item) => {
              const Icon = item.icon;

              return (
                <ListItemButton
                  key={item.to}
                  component={Link}
                  to={item.to}
                  selected={isCurrentPath(item.to)}
                  onClick={() => setMobileOpen(false)}
                >
                  <ListItemIcon>
                    <Icon />
                  </ListItemIcon>
                  <ListItemText primary={item.label} />
                </ListItemButton>
              );
            })}
          </List>

          <Divider />

          <List>
            {settingsNavigationItems.map((item) => {
              const Icon = item.icon;

              return (
                <ListItemButton
                  key={item.to}
                  component={Link}
                  to={item.to}
                  selected={isCurrentPath(item.to)}
                  onClick={() => setMobileOpen(false)}
                >
                  <ListItemIcon>
                    <Icon />
                  </ListItemIcon>
                  <ListItemText primary={item.label} />
                </ListItemButton>
              );
            })}
          </List>

          {!hasAuthCookie && (
            <>
              <Divider />
              <Box sx={{ p: 2, display: "flex", alignItems: "center", gap: 1 }}>
                <WarningAmberIcon color="warning" />
                <Typography variant="body2" color="warning.main">
                  Auth cookie not configured
                </Typography>
              </Box>
            </>
          )}
        </Box>
      </Drawer>

      <Box component="main" sx={{ pt: 8 }}>
        <Outlet />
      </Box>
    </>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <Box
      sx={{
        p: 4,
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        minHeight: "60vh",
      }}
    >
      <Paper sx={{ maxWidth: 600, width: "100%", p: 4 }} elevation={4}>
        <Typography variant="h3" color="error" gutterBottom>
          {message}
        </Typography>
        <Typography variant="body1" gutterBottom>
          {details}
        </Typography>
        {stack && (
          <Alert
            severity="info"
            sx={{
              mt: 2,
              whiteSpace: "pre-wrap",
              fontFamily: "monospace",
            }}
          >
            <code>{stack}</code>
          </Alert>
        )}
      </Paper>
    </Box>
  );
}
