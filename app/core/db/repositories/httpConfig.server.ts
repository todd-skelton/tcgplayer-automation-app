import type { HttpConfig } from "~/core/config/httpConfig.server";
import { asJson, execute, queryOne, type Queryable } from "../database.server";

type HttpConfigRow = {
  tcgAuthCookie: string;
  userAgent: string;
  domainConfigs: HttpConfig["domainConfigs"];
  adaptiveConfig: HttpConfig["adaptiveConfig"];
};

const CONFIG_KEY = "default";

export const httpConfigRepository = {
  async get(executor?: Queryable): Promise<HttpConfigRow | null> {
    return queryOne<HttpConfigRow>(
      `SELECT
        tcg_auth_cookie AS "tcgAuthCookie",
        user_agent AS "userAgent",
        domain_configs AS "domainConfigs",
        adaptive_config AS "adaptiveConfig"
      FROM http_config
      WHERE config_key = $1`,
      [CONFIG_KEY],
      executor,
    );
  },

  async save(config: HttpConfig, executor?: Queryable): Promise<void> {
    await execute(
      `INSERT INTO http_config (
        config_key,
        tcg_auth_cookie,
        user_agent,
        domain_configs,
        adaptive_config
      ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
      ON CONFLICT (config_key) DO UPDATE SET
        tcg_auth_cookie = EXCLUDED.tcg_auth_cookie,
        user_agent = EXCLUDED.user_agent,
        domain_configs = EXCLUDED.domain_configs,
        adaptive_config = EXCLUDED.adaptive_config`,
      [
        CONFIG_KEY,
        config.tcgAuthCookie,
        config.userAgent,
        asJson(config.domainConfigs),
        asJson(config.adaptiveConfig),
      ],
      executor,
    );
  },
};
