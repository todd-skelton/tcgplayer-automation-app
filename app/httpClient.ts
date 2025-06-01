import axios from "axios";

const axiosClient = axios.create({
  timeout: 5000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  },
});

export async function get<TResponse, TParams = any>(
  url: string,
  params?: TParams
): Promise<TResponse> {
  const { data } = await axiosClient.get<TResponse>(url, { params });
  return data;
}

export async function post<TResonse, TData = any>(
  url: string,
  data?: TData
): Promise<TResonse> {
  const { data: response } = await axiosClient.post<TResonse>(url, data);
  return response;
}
