import type { Route } from "./+types/home";
import { Welcome } from "../welcome/welcome";
import { getAllLatestSales } from "../tcgplayer/get-latest-sales";
import { data, useFetcher, type LoaderFunctionArgs } from "react-router";
import { getAllListings, getListings } from "~/tcgplayer/get-listings";
import { getCatalogSetNames } from "~/tcgplayer/get-catalog-set-names";
import path from "path";
import fs from "fs/promises";
import { getSetCards } from "~/tcgplayer/get-set-cards";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "New React Router App" },
    { name: "description", content: "Welcome to React Router!" },
  ];
}

// Loader to fetch latest sales
export async function loader({ request }: LoaderFunctionArgs) {
  // Example params; replace with real values as needed
  const id = 284137;
  try {
    const salesPromise = getAllLatestSales(
      { id },
      { listingType: "ListingWithoutPhotos" }
    );
    const listingsPromise = getAllListings(
      { id },
      {
        filters: {
          term: {
            sellerStatus: "Live",
            channelId: 0,
            listingType: ["standard"],
          },
          range: { quantity: { gte: 1 } },
          exclude: { channelExclusion: 0 },
        },
        size: 50,
        sort: { field: "price+shipping", order: "asc" },
        context: { shippingCountry: "US", cart: {} },
        aggregations: ["listingType"],
      }
    );
    const [sales, listings] = await Promise.all([
      salesPromise,
      listingsPromise,
    ]);
    return data({ sales, listings }, { status: 200 });
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}

export async function action() {
  try {
    // 1. Get all set names for category 3
    const setsResponse = await getCatalogSetNames({ categoryId: 3 });
    const sets = setsResponse.results;

    // 2. For each set, get cards and write to file if not already present
    const dir = path.resolve(process.cwd(), "app/tcgplayer/data/set-cards");
    await fs.mkdir(dir, { recursive: true });

    let skipped = 0;
    let written = 0;

    for (const set of sets) {
      const filePath = path.join(dir, `${set.setNameId}.json`);
      try {
        await fs.access(filePath);
        skipped++;
        continue; // File exists, skip
      } catch {
        // File does not exist, proceed
      }
      const cards = await getSetCards({ setId: set.setNameId });
      await fs.writeFile(filePath, JSON.stringify(cards, null, 2), "utf-8");
      written++;
    }

    return data(
      {
        message: `Fetched and saved ${written} sets. Skipped ${skipped} existing files.`,
      },
      { status: 200 }
    );
  } catch (error) {
    return data({ error: String(error) }, { status: 500 });
  }
}

export default function Home() {
  const fetcher = useFetcher<typeof loader>();
  const setFetcher = useFetcher<typeof action>();

  return (
    <div>
      <Welcome />
      <fetcher.Form method="get">
        <button type="submit">Get Latest Sales</button>
      </fetcher.Form>
      <setFetcher.Form method="post">
        <button type="submit">Fetch All Sets & Cards</button>
      </setFetcher.Form>
      {fetcher.data && "sales" in fetcher.data ? (
        <div>
          <h2>Latest Sales</h2>
          <pre>{JSON.stringify(fetcher.data.sales, null, 2)}</pre>
          <h2>Listings</h2>
          <pre>{JSON.stringify(fetcher.data.listings, null, 2)}</pre>
        </div>
      ) : fetcher.data && "error" in fetcher.data ? (
        <div>
          <h2>Error</h2>
          <pre>{fetcher.data.error}</pre>
        </div>
      ) : null}
      {setFetcher.data && "message" in setFetcher.data ? (
        <div>
          <h2>Set Cards Fetch Result</h2>
          <pre>{setFetcher.data.message}</pre>
        </div>
      ) : setFetcher.data && "error" in setFetcher.data ? (
        <div>
          <h2>Error</h2>
          <pre>{setFetcher.data.error}</pre>
        </div>
      ) : null}
    </div>
  );
}
// .
