@file:JvmName("X")
package com.example.app

import com.foo.Bar
import com.foo.baz.*
import com.foo.Quux as Q

/* outer /* nested */ still comment */
/** KDoc with class Fake { } */
@Entity
@Table(name = "users")
data class User(
    @field:Json(name = "id") val id: Long,
    private var name: String = "x${'$'}{",
    val tags: List<Map<String, Foo>>? = null,
    val cb: suspend (Int, String) -> Unit,
) : Base(id), Serializable, Comparable<User> by delegate {
    val repo = UserRepository()
    var count: Int = 0
        private set
    companion object {
        const val X = 1
        fun create(): User = User(1, "a")
    }
    fun <T : Any> List<T>.second(a: Int = 3, b: Map<String, Int> = emptyMap<String, Int>()): T where T : Comparable<T> {
        val x = Foo.Bar.create()
        println("hi $x and ${Other.name}")
        return this[1]
    }
    constructor(a: Int) : this(a.toLong())
    inner class In
    enum class Color(val rgb: Int) { RED(1), GREEN(2) { override fun f() = 1 }; fun g() {} }
}

sealed interface Shape { fun area(): Double }
data object Nothing2 : Shape
value class Id(val v: Int)
typealias Handler = (Event) -> Unit
fun interface Cb { fun run() }
fun String.shout(): String = this.uppercase()
val topVal by lazy { Foo() }
object Single : Base() {
    val x = object : Runnable { override fun run() {} }
}

@Service
class OrderService(
    private val repo: OrderRepository,
    private val clients: Map<String, Client> = emptyMap(),
) : BaseService<Order>(), Closeable {
    companion object {
        private val log = LoggerFactory.getLogger(OrderService::class.java)
        const val LIMIT = 10
    }

    @Transactional
    suspend fun place(req: PlaceRequest): Result<Order> = runCatching {
        val order = repo.save(Order(req.id, "${req.name}-${Clock.now()}"))
        clients["a"]?.send(order) ?: throw IllegalStateException("none: $order")
        when (order.state) {
            State.NEW -> log.info("new")
            is State.Done -> {}
            else -> Unit
        }
        order
    }

    override fun close() { repo.flush() }
}

enum class State(val code: Int) {
    NEW(1), OPEN(2) { override fun label() = "open" };
    open fun label(): String = name
}
val handler: (Int) -> Unit = { x -> println(x) }
fun <T> List<T>.firstOr(default: T): T = firstOrNull() ?: default
