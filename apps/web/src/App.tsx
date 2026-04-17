import { useDeferredValue, useEffect, useMemo, useState, useTransition } from "react";

import { api } from "./api";
import type {
  DemoUser,
  PickupReservation,
  PickupSlot,
  Product,
  ProductFormState,
  ProductStatus,
  Store,
} from "./types";

const emptyProductForm: ProductFormState = {
  sku: "",
  name: "",
  description: "",
  price: "10000",
  stock: "10",
  status: "ACTIVE",
};

const roleLabels = {
  seller: "판매자",
  customer: "고객",
} as const;

const productStatusLabels = {
  ACTIVE: "판매중",
  INACTIVE: "판매중지",
} as const;

const reservationStatusLabels = {
  RESERVED: "예약 완료",
  READY: "픽업 준비",
  PICKED_UP: "수령 완료",
  CANCELLED: "예약 취소",
  NO_SHOW: "미수령",
} as const;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function currency(amount: number) {
  return new Intl.NumberFormat("ko-KR", {
    style: "currency",
    currency: "KRW",
    maximumFractionDigits: 0,
  }).format(amount);
}

export default function App() {
  const [stores, setStores] = useState<Store[]>([]);
  const [users, setUsers] = useState<DemoUser[]>([]);
  const [selectedActorId, setSelectedActorId] = useState<string>("");
  const [selectedCustomerStoreId, setSelectedCustomerStoreId] = useState<string>("");
  const [selectedDate, setSelectedDate] = useState<string>(today());
  const [products, setProducts] = useState<Product[]>([]);
  const [slots, setSlots] = useState<PickupSlot[]>([]);
  const [sellerReservations, setSellerReservations] = useState<PickupReservation[]>([]);
  const [customerReservationsByActor, setCustomerReservationsByActor] = useState<
    Record<string, PickupReservation[]>
  >({});
  const [selectedProductId, setSelectedProductId] = useState<string>("");
  const [selectedSlotId, setSelectedSlotId] = useState<string>("");
  const [reservationQuantity, setReservationQuantity] = useState<string>("1");
  const [productSearch, setProductSearch] = useState("");
  const [productForm, setProductForm] = useState<ProductFormState>(emptyProductForm);
  const [statusMessage, setStatusMessage] = useState<string>("데모 데이터를 불러오는 중입니다.");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [isPending, startTransition] = useTransition();

  const deferredSearch = useDeferredValue(productSearch);
  const storeNameById = useMemo(
    () => new Map(stores.map((store) => [store.id, store.name])),
    [stores],
  );

  const selectedActor = users.find((user) => user.id === selectedActorId) ?? null;
  const sellerStoreId = selectedActor?.role === "seller" ? selectedActor.storeId : null;
  const activeStoreId =
    selectedActor?.role === "seller"
      ? sellerStoreId ?? ""
      : selectedCustomerStoreId;
  const customerReservations =
    selectedActor?.role === "customer"
      ? customerReservationsByActor[selectedActor.id] ?? []
      : [];

  const filteredProducts = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    if (!query) {
      return products;
    }
    return products.filter((product) =>
      [product.name, product.sku, product.description].some((value) =>
        value.toLowerCase().includes(query),
      ),
    );
  }, [deferredSearch, products]);

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    if (!selectedActor) {
      return;
    }

    if (selectedActor.role === "seller" && selectedActor.storeId) {
      setSelectedCustomerStoreId((current) => current || stores[0]?.id || "");
      void refreshStoreData(selectedActor.storeId, selectedDate);
      return;
    }

    if (selectedCustomerStoreId) {
      void refreshStoreData(selectedCustomerStoreId, selectedDate);
    }
  }, [selectedActorId, selectedCustomerStoreId, selectedDate, stores]);

  async function bootstrap() {
    try {
      const [storeList, userList] = await Promise.all([api.listStores(), api.listDemoUsers()]);
      setStores(storeList);
      setUsers(userList);

      const defaultActor = userList.find((user) => user.role === "seller") ?? userList[0];
      if (defaultActor) {
        setSelectedActorId(defaultActor.id);
      }

      const defaultStore = storeList[0];
      if (defaultStore) {
        setSelectedCustomerStoreId(defaultStore.id);
      }

      setStatusMessage("데모 데이터 준비가 완료되었습니다.");
      setErrorMessage("");
    } catch (error) {
      setErrorMessage((error as Error).message);
      setStatusMessage("데모 데이터를 불러오지 못했습니다.");
    }
  }

  async function refreshStoreData(storeId: string, date: string) {
    if (!storeId) {
      return;
    }

    try {
      const [nextProducts, nextSlots] = await Promise.all([
        api.listProducts(storeId),
        api.listPickupSlots(storeId, date),
      ]);

      setProducts(nextProducts);
      setSlots(nextSlots);

      setSelectedProductId((current) => current && nextProducts.some((product) => product.id === current) ? current : nextProducts[0]?.id ?? "");
      setSelectedSlotId((current) => current && nextSlots.some((slot) => slot.id === current) ? current : nextSlots[0]?.id ?? "");

      if (selectedActor?.role === "seller" && selectedActor.storeId === storeId) {
        const reservations = await api.listReservations(storeId, selectedActor.id, date);
        setSellerReservations(reservations);
      } else {
        setSellerReservations([]);
      }

      setErrorMessage("");
    } catch (error) {
      setErrorMessage((error as Error).message);
    }
  }

  async function handleCreateProduct(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedActor || selectedActor.role !== "seller" || !selectedActor.storeId) {
      return;
    }

    try {
      await api.createProduct(selectedActor.storeId, selectedActor.id, {
        sku: productForm.sku,
        name: productForm.name,
        description: productForm.description,
        price: Number(productForm.price),
        stock: Number(productForm.stock),
        status: productForm.status,
      });

      setProductForm(emptyProductForm);
      setStatusMessage("상품이 등록되었습니다.");
      startTransition(() => {
        void refreshStoreData(selectedActor.storeId!, selectedDate);
      });
    } catch (error) {
      setErrorMessage((error as Error).message);
    }
  }

  async function handleQuickProductUpdate(
    productId: string,
    patch: Partial<{ stock: number; status: ProductStatus }>,
  ) {
    if (!selectedActor || selectedActor.role !== "seller" || !selectedActor.storeId) {
      return;
    }

    try {
      await api.updateProduct(selectedActor.storeId, productId, selectedActor.id, patch);
      setStatusMessage("상품 정보가 수정되었습니다.");
      startTransition(() => {
        void refreshStoreData(selectedActor.storeId!, selectedDate);
      });
    } catch (error) {
      setErrorMessage((error as Error).message);
    }
  }

  async function handleCreateReservation() {
    if (!selectedActor || selectedActor.role !== "customer" || !activeStoreId || !selectedProductId || !selectedSlotId) {
      return;
    }

    try {
      const reservation = await api.createReservation(selectedActor.id, {
        storeId: activeStoreId,
        productId: selectedProductId,
        slotId: selectedSlotId,
        quantity: Number(reservationQuantity),
      });

      setCustomerReservationsByActor((current) => ({
        ...current,
        [selectedActor.id]: [reservation, ...(current[selectedActor.id] ?? [])],
      }));
      setStatusMessage(`예약이 완료되었습니다. 픽업 코드: ${reservation.pickupCode}`);
      startTransition(() => {
        void refreshStoreData(activeStoreId, selectedDate);
      });
    } catch (error) {
      setErrorMessage((error as Error).message);
    }
  }

  async function handleCancelReservation(reservationId: string) {
    if (!selectedActor || selectedActor.role !== "customer") {
      return;
    }

    try {
      const updated = await api.cancelReservation(reservationId, selectedActor.id);
      setCustomerReservationsByActor((current) => ({
        ...current,
        [selectedActor.id]: (current[selectedActor.id] ?? []).map((reservation) =>
          reservation.id === reservationId ? updated : reservation,
        ),
      }));
      setStatusMessage(`예약이 취소되었습니다. 픽업 코드: ${updated.pickupCode}`);
      startTransition(() => {
        if (activeStoreId) {
          void refreshStoreData(activeStoreId, selectedDate);
        }
      });
    } catch (error) {
      setErrorMessage((error as Error).message);
    }
  }

  async function handleReservationStatus(reservationId: string, status: "READY" | "PICKED_UP" | "NO_SHOW") {
    if (!selectedActor || selectedActor.role !== "seller" || !selectedActor.storeId) {
      return;
    }

    try {
      const updated = await api.updateReservationStatus(reservationId, selectedActor.id, status);
      setSellerReservations((current) =>
        current.map((reservation) =>
          reservation.id === reservationId ? updated : reservation,
        ),
      );
      setStatusMessage(`예약 상태가 ${reservationStatusLabels[status]}(으)로 변경되었습니다.`);
    } catch (error) {
      setErrorMessage((error as Error).message);
    }
  }

  const selectedStore = stores.find((store) => store.id === activeStoreId) ?? null;
  const selectedProduct = products.find((product) => product.id === selectedProductId) ?? null;

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">k6 데모 마켓</p>
          <h1>멀티 매장 픽업 마켓</h1>
          <p className="hero-copy">
            판매자는 상품 등록과 재고 조정, 예약 운영을 처리하고 고객은 매장별 한정 픽업 슬롯을 두고
            예약 경쟁을 진행합니다.
          </p>
        </div>
        <div className="hero-stats">
          <article>
            <span>매장 수</span>
            <strong>{stores.length}</strong>
          </article>
          <article>
            <span>상품 수</span>
            <strong>{products.length}</strong>
          </article>
          <article>
            <span>예약 가능 슬롯</span>
            <strong>{slots.reduce((sum, slot) => sum + slot.remainingCapacity, 0)}</strong>
          </article>
        </div>
      </header>

      <main className="dashboard">
        <aside className="control-panel">
          <section className="panel-card">
            <h2>사용자 역할</h2>
            <p className="muted">데이터를 다시 불러오지 않고 역할을 전환할 수 있습니다.</p>
            <div className="actor-grid">
              {users.map((user) => (
                <button
                  type="button"
                  key={user.id}
                  className={user.id === selectedActorId ? "actor-button active" : "actor-button"}
                  onClick={() => setSelectedActorId(user.id)}
                >
                  <span>{user.name}</span>
                  <small>
                    {roleLabels[user.role]}
                    {user.storeId ? ` · ${storeNameById.get(user.storeId) ?? user.storeId}` : ""}
                  </small>
                </button>
              ))}
            </div>
          </section>

          <section className="panel-card">
            <h2>매장 및 날짜</h2>
            <label className="field">
              <span>픽업 날짜</span>
              <input
                type="date"
                value={selectedDate}
                onChange={(event) => setSelectedDate(event.target.value)}
              />
            </label>

            {selectedActor?.role === "customer" ? (
              <label className="field">
                <span>매장</span>
                <select
                  value={selectedCustomerStoreId}
                  onChange={(event) => setSelectedCustomerStoreId(event.target.value)}
                >
                  {stores.map((store) => (
                    <option key={store.id} value={store.id}>
                      {store.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <div className="store-summary">
                <span>{selectedStore?.name ?? "선택된 매장이 없습니다."}</span>
                <small>{selectedStore?.address ?? ""}</small>
              </div>
            )}
          </section>

          <section className="panel-card">
            <h2>상태 안내</h2>
            <p>{statusMessage}</p>
            {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
            {isPending ? <p className="muted">매장 데이터를 새로 불러오는 중입니다.</p> : null}
          </section>
        </aside>

        <section className="workspace">
          <div className="workspace-topbar">
            <div>
              <h2>{selectedActor?.role === "seller" ? "판매자 운영" : "고객 예약 흐름"}</h2>
              <p className="muted">
                {selectedStore
                  ? `${selectedStore.name} · ${selectedStore.city}`
                  : "매장을 선택해 시작하세요."}
              </p>
            </div>
            <label className="search-field">
              <span>상품 검색</span>
              <input
                value={productSearch}
                onChange={(event) => setProductSearch(event.target.value)}
                placeholder="상품명, SKU, 설명으로 검색"
              />
            </label>
          </div>

          {selectedActor?.role === "seller" ? (
            <div className="workspace-grid">
              <section className="panel-card">
                <h3>상품 등록</h3>
                <form className="stacked-form" onSubmit={handleCreateProduct}>
                  <label className="field">
                    <span>SKU</span>
                    <input
                      value={productForm.sku}
                      onChange={(event) => setProductForm((current) => ({ ...current, sku: event.target.value }))}
                      placeholder="SEOUL-APPLE-001"
                    />
                  </label>
                  <label className="field">
                    <span>상품명</span>
                    <input
                      value={productForm.name}
                      onChange={(event) => setProductForm((current) => ({ ...current, name: event.target.value }))}
                      placeholder="서울 사과 세트"
                    />
                  </label>
                  <label className="field">
                    <span>설명</span>
                    <textarea
                      value={productForm.description}
                      onChange={(event) => setProductForm((current) => ({ ...current, description: event.target.value }))}
                      rows={3}
                    />
                  </label>
                  <div className="split-fields">
                    <label className="field">
                      <span>가격(원)</span>
                      <input
                        type="number"
                        value={productForm.price}
                        onChange={(event) => setProductForm((current) => ({ ...current, price: event.target.value }))}
                      />
                    </label>
                    <label className="field">
                      <span>재고</span>
                      <input
                        type="number"
                        value={productForm.stock}
                        onChange={(event) => setProductForm((current) => ({ ...current, stock: event.target.value }))}
                      />
                    </label>
                  </div>
                  <label className="field">
                    <span>상태</span>
                    <select
                      value={productForm.status}
                      onChange={(event) =>
                        setProductForm((current) => ({ ...current, status: event.target.value as ProductStatus }))
                      }
                    >
                      <option value="ACTIVE">{productStatusLabels.ACTIVE}</option>
                      <option value="INACTIVE">{productStatusLabels.INACTIVE}</option>
                    </select>
                  </label>
                  <button type="submit" className="primary-button">상품 등록하기</button>
                </form>
              </section>

              <section className="panel-card">
                <h3>상품 목록</h3>
                <div className="product-list">
                  {filteredProducts.map((product) => (
                    <article key={product.id} className="product-card">
                      <div className="product-head">
                        <div>
                          <strong>{product.name}</strong>
                          <small>{product.sku}</small>
                        </div>
                        <span className={`status-pill ${product.status.toLowerCase()}`}>
                          {productStatusLabels[product.status]}
                        </span>
                      </div>
                      <p>{product.description}</p>
                      <div className="product-metrics">
                        <span>{currency(product.price)}</span>
                        <span>재고 {product.stock}개</span>
                      </div>
                      <div className="button-row">
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => handleQuickProductUpdate(product.id, { stock: product.stock + 5 })}
                        >
                          재고 +5
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() =>
                            handleQuickProductUpdate(product.id, {
                              status: product.status === "ACTIVE" ? "INACTIVE" : "ACTIVE",
                            })
                          }
                        >
                          판매 상태 전환
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </section>

              <section className="panel-card span-2">
                <h3>{selectedDate} 예약 현황</h3>
                <div className="reservation-list">
                  {sellerReservations.map((reservation) => (
                    <article key={reservation.id} className="reservation-card">
                      <div>
                        <strong>{reservation.productName}</strong>
                        <small>{reservation.customerName} · {reservation.startTime}-{reservation.endTime}</small>
                      </div>
                      <div className="reservation-meta">
                        <span>{reservation.pickupCode}</span>
                        <span className={`status-pill ${reservation.status.toLowerCase()}`}>
                          {reservationStatusLabels[reservation.status]}
                        </span>
                      </div>
                      <div className="button-row">
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => handleReservationStatus(reservation.id, "READY")}
                        >
                          픽업 준비
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => handleReservationStatus(reservation.id, "PICKED_UP")}
                        >
                          수령 완료
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => handleReservationStatus(reservation.id, "NO_SHOW")}
                        >
                          미수령 처리
                        </button>
                      </div>
                    </article>
                  ))}
                  {sellerReservations.length === 0 ? <p className="muted">해당 날짜 예약이 없습니다.</p> : null}
                </div>
              </section>
            </div>
          ) : (
            <div className="workspace-grid">
              <section className="panel-card">
                <h3>상품 선택</h3>
                <div className="product-list">
                  {filteredProducts.map((product) => (
                    <button
                      type="button"
                      key={product.id}
                      className={product.id === selectedProductId ? "select-card active" : "select-card"}
                      onClick={() => setSelectedProductId(product.id)}
                    >
                      <strong>{product.name}</strong>
                      <small>{product.sku}</small>
                      <span>{currency(product.price)}</span>
                      <em>재고 {product.stock}개 남음</em>
                    </button>
                  ))}
                </div>
              </section>

              <section className="panel-card">
                <h3>픽업 슬롯 선택</h3>
                <div className="slot-grid">
                  {slots.map((slot) => (
                    <button
                      type="button"
                      key={slot.id}
                      className={slot.id === selectedSlotId ? "select-card active" : "select-card"}
                      onClick={() => setSelectedSlotId(slot.id)}
                      disabled={slot.remainingCapacity < 1}
                    >
                      <strong>{slot.startTime} - {slot.endTime}</strong>
                      <small>잔여 {slot.remainingCapacity}/{slot.capacity}</small>
                    </button>
                  ))}
                </div>
              </section>

              <section className="panel-card">
                <h3>픽업 예약</h3>
                <div className="reservation-summary">
                  <p><strong>매장</strong> {selectedStore?.name ?? "-"}</p>
                  <p><strong>상품</strong> {selectedProduct?.name ?? "-"}</p>
                  <label className="field">
                    <span>수량</span>
                    <input
                      type="number"
                      min="1"
                      value={reservationQuantity}
                      onChange={(event) => setReservationQuantity(event.target.value)}
                    />
                  </label>
                  <button type="button" className="primary-button" onClick={handleCreateReservation}>
                    픽업 예약하기
                  </button>
                </div>
              </section>

              <section className="panel-card span-2">
                <h3>현재 세션 예약 내역</h3>
                <div className="reservation-list">
                  {customerReservations.map((reservation) => (
                    <article key={reservation.id} className="reservation-card">
                      <div>
                        <strong>{reservation.productName}</strong>
                        <small>{reservation.slotDate} · {reservation.startTime}-{reservation.endTime}</small>
                      </div>
                      <div className="reservation-meta">
                        <span>{reservation.pickupCode}</span>
                        <span className={`status-pill ${reservation.status.toLowerCase()}`}>
                          {reservationStatusLabels[reservation.status]}
                        </span>
                      </div>
                      <div className="button-row">
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => handleCancelReservation(reservation.id)}
                          disabled={!["RESERVED", "READY"].includes(reservation.status)}
                        >
                          예약 취소
                        </button>
                      </div>
                    </article>
                  ))}
                  {customerReservations.length === 0 ? (
                    <p className="muted">예약을 생성하면 여기에서 예약 ID와 픽업 코드를 확인할 수 있습니다.</p>
                  ) : null}
                </div>
              </section>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
