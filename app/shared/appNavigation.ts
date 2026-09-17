import type { SvgIconComponent } from "@mui/icons-material";
import AccountBalanceWalletIcon from "@mui/icons-material/AccountBalanceWallet";
import BatchPredictionIcon from "@mui/icons-material/BatchPrediction";
import HttpIcon from "@mui/icons-material/Http";
import Inventory2Icon from "@mui/icons-material/Inventory2";
import LocalShippingIcon from "@mui/icons-material/LocalShipping";
import LoopIcon from "@mui/icons-material/Loop";
import PriceCheckIcon from "@mui/icons-material/PriceCheck";
import PublishIcon from "@mui/icons-material/Publish";
import QueryStatsIcon from "@mui/icons-material/QueryStats";
import SettingsIcon from "@mui/icons-material/Settings";
import StorageIcon from "@mui/icons-material/Storage";
import ViewListIcon from "@mui/icons-material/ViewList";

export interface NavigationItem {
  label: string;
  to: string;
  icon: SvgIconComponent;
  description: string;
}

export const primaryNavigationItems: NavigationItem[] = [
  {
    label: "Inventory",
    to: "/inventory-manager",
    icon: Inventory2Icon,
    description: "Add new inventory and freeze it into a pricing batch",
  },
  {
    label: "Batch Pricer",
    to: "/pending-inventory-pricer",
    icon: BatchPredictionIcon,
    description: "Create, price, publish, and download inventory batches",
  },
  {
    label: "Continuous Pricing",
    to: "/continuous-pricing",
    icon: LoopIcon,
    description: "Automatic repricing runs for live inventory",
  },
  {
    label: "Slab Pricing",
    to: "/slab-pricing",
    icon: PriceCheckIcon,
    description: "Research and price graded cards for eBay",
  },
  {
    label: "Price Matrix",
    to: "/product-price-matrix",
    icon: PriceCheckIcon,
    description: "Compare one product across conditions and variants",
  },
  {
    label: "Inventory Strategy",
    to: "/inventory-strategy",
    icon: QueryStatsIcon,
    description: "Pricing hurdle, capital turnaround, and selling speed",
  },
  {
    label: "Inventory Economics",
    to: "/inventory-economics",
    icon: AccountBalanceWalletIcon,
    description: "Estimated cost, proceeds, and realized profit by order",
  },
  {
    label: "Pull Sheet",
    to: "/pull-sheet",
    icon: ViewListIcon,
    description: "Upload and view pull sheets",
  },
  {
    label: "Shipping Export",
    to: "/shipping-export",
    icon: LocalShippingIcon,
    description: "Review shipments, buy postage, and notify buyers",
  },
  {
    label: "Data Mgmt",
    to: "/data-management",
    icon: StorageIcon,
    description: "Refresh product lines, sets, products, and SKUs",
  },
];

export const settingsNavigationItems: NavigationItem[] = [
  {
    label: "Configuration",
    to: "/configuration",
    icon: SettingsIcon,
    description: "Pricing rules and defaults",
  },
  {
    label: "Inventory Publication",
    to: "/publication-configuration",
    icon: PublishIcon,
    description: "Automatic publication and guardrails",
  },
  {
    label: "Shipping Configuration",
    to: "/shipping-configuration",
    icon: LocalShippingIcon,
    description: "Postage and shipping defaults",
  },
  {
    label: "HTTP Configuration",
    to: "/http-configuration",
    icon: HttpIcon,
    description: "TCGPlayer authentication and rate limits",
  },
  {
    label: "Slab data connections",
    to: "/slab-connections",
    icon: HttpIcon,
    description: "eBay research and Alt credentials",
  },
];
