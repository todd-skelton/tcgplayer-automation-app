import type { SvgIconComponent } from "@mui/icons-material";
import BatchPredictionIcon from "@mui/icons-material/BatchPrediction";
import HttpIcon from "@mui/icons-material/Http";
import Inventory2Icon from "@mui/icons-material/Inventory2";
import LocalShippingIcon from "@mui/icons-material/LocalShipping";
import SettingsIcon from "@mui/icons-material/Settings";
import StorageIcon from "@mui/icons-material/Storage";
import StorefrontIcon from "@mui/icons-material/Storefront";
import UploadFileIcon from "@mui/icons-material/UploadFile";
import ViewListIcon from "@mui/icons-material/ViewList";

export interface NavigationItem {
  label: string;
  to: string;
  icon: SvgIconComponent;
}

export interface DashboardCard extends NavigationItem {
  title: string;
  description: string;
  color: string;
}

export const primaryNavigationItems: NavigationItem[] = [
  { label: "CSV Pricer", to: "/pricer", icon: UploadFileIcon },
  { label: "Seller Pricer", to: "/seller-pricer", icon: StorefrontIcon },
  { label: "Inventory", to: "/inventory-manager", icon: Inventory2Icon },
  {
    label: "Batch Pricer",
    to: "/pending-inventory-pricer",
    icon: BatchPredictionIcon,
  },
  { label: "Pull Sheet", to: "/pull-sheet", icon: ViewListIcon },
  {
    label: "Shipping Export",
    to: "/shipping-export",
    icon: LocalShippingIcon,
  },
  { label: "Data Mgmt", to: "/data-management", icon: StorageIcon },
];

export const settingsNavigationItems: NavigationItem[] = [
  { label: "Configuration", to: "/configuration", icon: SettingsIcon },
  {
    label: "Shipping Configuration",
    to: "/shipping-configuration",
    icon: LocalShippingIcon,
  },
  {
    label: "HTTP Configuration",
    to: "/http-configuration",
    icon: HttpIcon,
  },
];

export const dashboardCards: DashboardCard[] = [
  {
    title: "CSV Pricer",
    label: "CSV Pricer",
    description: "Upload and price TCGPlayer CSV export files",
    to: "/pricer",
    icon: UploadFileIcon,
    color: "primary.main",
  },
  {
    title: "Seller Inventory Pricer",
    label: "Seller Pricer",
    description: "Fetch and price all listings for a specific seller",
    to: "/seller-pricer",
    icon: StorefrontIcon,
    color: "secondary.main",
  },
  {
    title: "Inventory Manager",
    label: "Inventory",
    description: "Add new inventory items to your collection",
    to: "/inventory-manager",
    icon: Inventory2Icon,
    color: "success.main",
  },
  {
    title: "Inventory Batch Pricer",
    label: "Batch Pricer",
    description: "Manage frozen batches, repricing, and downloads",
    to: "/pending-inventory-pricer",
    icon: BatchPredictionIcon,
    color: "info.main",
  },
  {
    title: "Pull Sheet",
    label: "Pull Sheet",
    description: "Upload and view pull sheets with grid and table views",
    to: "/pull-sheet",
    icon: ViewListIcon,
    color: "warning.main",
  },
  {
    title: "Shipping Export",
    label: "Shipping Export",
    description: "Convert TCGPlayer shipping exports into EasyPost batch files",
    to: "/shipping-export",
    icon: LocalShippingIcon,
    color: "error.main",
  },
  {
    title: "Data Management",
    label: "Data Mgmt",
    description: "Fetch and manage product lines, categories, and SKU data",
    to: "/data-management",
    icon: StorageIcon,
    color: "text.secondary",
  },
];
