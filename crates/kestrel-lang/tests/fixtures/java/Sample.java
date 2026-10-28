package com.example.app;

import java.util.*;
import static java.util.Collections.emptyList;
import com.foo.Bar;

/** Javadoc class Fake { } */
@Entity
@Table(name = "users")
public class User<T extends Comparable<T> & Serializable> extends Base<T> implements Serializable, Comparable<User<T>> {
    private static final int MAX = 10;
    protected final List<Map<String, Foo>> items = new ArrayList<>(), more = null;
    int a, b[];
    String text = """
        class Fake { Foo x; }
        """;
    char q = '\'';

    public User() { super(); }
    User(int x, String... names) throws IOException, FooException { this.a = x; }

    public <R> R apply(Function<? super T, ? extends R> f, @Nullable final String[] arr, int n[]) {
        Foo foo = new Foo();
        var bar = (Bar) obj;
        Runnable r = new Runnable() { public void run() { Helper.go(); } };
        for (Entry<String, Foo> e : map.entrySet()) {}
        if (o instanceof Baz z) { return Baz.class; }
        return list.stream().map(Qux::new).collect(Collectors.toList());
    }

    abstract void abs();
    static class Nested { }
    enum Kind { A, B(2) { void f() {} }, C; private final int v; Kind() {} Kind(int v) { this.v = v; } }
    interface Cb { void run(); default void d() {} static void s() {} int K = 1; }
    record Point(int x, List<Foo> ys) implements Shape { Point { } }
    @interface Ann { String value() default "x"; }
}

@Service
class OrderService extends BaseService<Order> implements Closeable {
    private static final Logger LOG = LoggerFactory.getLogger(OrderService.class);
    private final OrderRepository repo;
    private final Map<String, Client> clients = new HashMap<>();

    OrderService(OrderRepository repo) { this.repo = repo; }

    @Transactional
    public Result<Order> place(final PlaceRequest req) throws IOException {
        Order order = repo.save(new Order(req.getId(), req.getName() + "-" + Clock.now()));
        Client c = clients.get("a");
        if (c != null) { c.send(order); } else { throw new IllegalStateException("none: " + order); }
        switch (order.getState()) {
            case NEW: LOG.info("new"); break;
            default: break;
        }
        Runnable r = () -> repo.flush();
        Comparator<Order> cmp = Comparator.comparing(Order::getId);
        return Result.ok(order);
    }

    @Override public void close() { repo.flush(); }
}
